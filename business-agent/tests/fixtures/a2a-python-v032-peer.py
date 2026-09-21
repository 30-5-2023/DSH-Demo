"""Exact a2a-sdk 0.3.2 client/server peer for bridge interoperability tests."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import socket
import sys
import uuid
from typing import Any

import httpx
import uvicorn
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.apps import A2AStarletteApplication
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
    Message,
    Part,
    Role,
    Task,
    TaskIdParams,
    TaskQueryParams,
    TextPart,
)

EXPECTED_VERSION = "0.3.2"


def assert_package_version() -> str:
    """Return the installed package version or fail before network activity."""
    version = importlib.metadata.version("a2a-sdk")
    if version != EXPECTED_VERSION:
        raise RuntimeError(f"expected a2a-sdk {EXPECTED_VERSION}, found {version}")
    return version


def message(text: str) -> Message:
    """Create one package-native user message."""
    return Message(
        role=Role.user,
        message_id=str(uuid.uuid4()),
        parts=[Part(root=TextPart(text=text))],
    )


def task_from_event(event: Any) -> Task | None:
    """Return the aggregate Task carried by a client event."""
    if isinstance(event, tuple) and event and isinstance(event[0], Task):
        return event[0]
    return event if isinstance(event, Task) else None


def task_text(task: Task) -> str:
    """Join text artifacts from a terminal Task."""
    return "".join(
        part.root.text
        for artifact in task.artifacts or []
        for part in artifact.parts
        if isinstance(part.root, TextPart)
    )


async def client_mode(base_url: str) -> None:
    """Drive the JavaScript bridge through the public Python 0.3.2 APIs."""
    version = assert_package_version()
    async with httpx.AsyncClient(timeout=20.0) as http_client:
        card = await A2ACardResolver(http_client, base_url).get_agent_card()
        client = ClientFactory(
            ClientConfig(httpx_client=http_client, streaming=True)
        ).create(card)

        terminal: Task | None = None
        async for event in client.send_message(message("python-to-js")):
            candidate = task_from_event(event)
            if candidate is not None:
                terminal = candidate
        if terminal is None:
            raise RuntimeError("Python client did not receive a Task")

        fetched = await client.get_task(TaskQueryParams(id=terminal.id))

        cancel_stream = client.send_message(message("python-cancel"))
        first = await anext(cancel_stream)
        cancel_task = task_from_event(first)
        if cancel_task is None:
            raise RuntimeError("Python cancellation stream did not begin with a Task")
        canceled = await client.cancel_task(TaskIdParams(id=cancel_task.id))
        await cancel_stream.aclose()

        print(
            json.dumps(
                {
                    "packageVersion": version,
                    "output": task_text(terminal),
                    "lookupState": fetched.status.state.value,
                    "canceledState": canceled.status.state.value,
                }
            ),
            flush=True,
        )


class EchoExecutor(AgentExecutor):
    """Minimal Python 0.3.2 Agent that completes every admitted message."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.submit()
        await updater.start_work()
        await updater.add_artifact(
            [Part(root=TextPart(text=f"py032:{context.get_user_input()}"))],
            name="result",
            last_chunk=True,
        )
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel()


async def server_mode() -> None:
    """Serve a Python 0.3.2 Agent on an atomically allocated loopback port."""
    assert_package_version()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    card = AgentCard(
        name="Python 0.3.2 Agent",
        description="Exact-version JavaScript interoperability fixture",
        version="0.3.2",
        protocol_version="0.3.0",
        url=f"{base_url}/a2a",
        preferred_transport="JSONRPC",
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[AgentSkill(
            id="interop",
            name="Interop",
            description="Echo interoperability requests",
            tags=["test"],
        )],
    )
    handler = DefaultRequestHandler(
        agent_executor=EchoExecutor(),
        task_store=InMemoryTaskStore(),
    )
    app = A2AStarletteApplication(agent_card=card, http_handler=handler).build(
        rpc_url="/a2a"
    )
    print(json.dumps({"baseUrl": base_url, "packageVersion": EXPECTED_VERSION}), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off"))
    await server.serve(sockets=[listener])


def main() -> None:
    """Dispatch the requested fixture mode."""
    if len(sys.argv) == 3 and sys.argv[1] == "client":
        asyncio.run(client_mode(sys.argv[2].rstrip("/")))
        return
    if len(sys.argv) == 2 and sys.argv[1] == "server":
        asyncio.run(server_mode())
        return
    raise SystemExit("usage: a2a-python-v032-peer.py client BASE_URL | server")


if __name__ == "__main__":
    main()
