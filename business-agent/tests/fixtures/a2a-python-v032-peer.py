"""Exact a2a-sdk 0.3.2 client/server peer for bridge interoperability tests."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
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
    DataPart,
    FilePart,
    FileWithBytes,
    FileWithUri,
    Message,
    Part,
    Role,
    Task,
    TaskIdParams,
    TaskQueryParams,
    TaskState,
    TextPart,
)
from starlette.responses import Response

EXPECTED_VERSION = "0.3.2"
MIB = 1024 * 1024
QUESTION_DATA = {
    "schema": "urn:deepseek-harness:a2a:input-required:v1",
    "questions": [{
        "id": "environment", "question": "Select the environment",
        "options": [{"label": "Test"}, {"label": "Production"}],
    }],
}
ANSWER_DATA = {
    "schema": "urn:deepseek-harness:a2a:input-response:v1",
    "answers": [{"id": "environment", "selected": ["Test"]}],
}


def payload(size: int, marker: bytes) -> bytes:
    """Return deterministic bytes of the requested size."""
    return (marker * ((size + len(marker) - 1) // len(marker)))[:size]


PYTHON_INPUT_INLINE = payload(MIB, b"python-inline-")
PYTHON_INPUT_URI = payload(MIB + 1, b"python-uri-")
PYTHON_OUTPUT_INLINE = payload(MIB, b"python-output-inline-")
PYTHON_OUTPUT_URI = payload(MIB + 1, b"python-output-uri-")


def digest(data: bytes) -> str:
    """Return a lowercase SHA-256 digest."""
    return hashlib.sha256(data).hexdigest()


def assert_package_version() -> str:
    """Return the installed package version or fail before network activity."""
    version = importlib.metadata.version("a2a-sdk")
    if version != EXPECTED_VERSION:
        raise RuntimeError(f"expected a2a-sdk {EXPECTED_VERSION}, found {version}")
    return version


def message(text: str, parts: list[Part] | None = None) -> Message:
    """Create one package-native user message."""
    return Message(
        role=Role.user,
        message_id=str(uuid.uuid4()),
        parts=parts or [Part(root=TextPart(text=text))],
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


async def download_verdict(url: str, target: Path) -> dict[str, Any]:
    """Stream one URI to disk and return metadata without embedding its bytes."""
    sha256 = hashlib.sha256()
    size = 0
    async with httpx.AsyncClient(timeout=20.0) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with target.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    output.write(chunk)
                    sha256.update(chunk)
                    size += len(chunk)
    return {"bytes": size, "sha256": sha256.hexdigest()}


async def task_file_verdicts(task: Task, temp_dir: Path) -> list[dict[str, Any]]:
    """Inspect package-native file classes and hash their exact bytes."""
    verdicts: list[dict[str, Any]] = []
    for artifact in task.artifacts or []:
        for index, part in enumerate(artifact.parts):
            root = part.root
            if not isinstance(root, FilePart):
                continue
            file = root.file
            if isinstance(file, FileWithBytes):
                data = base64.b64decode(file.bytes, validate=True)
                transfer = {"bytes": len(data), "sha256": digest(data)}
            elif isinstance(file, FileWithUri):
                transfer = await download_verdict(
                    file.uri, temp_dir / f"python-client-download-{index}.bin"
                )
            else:
                raise RuntimeError(f"unexpected file class {type(file).__name__}")
            verdicts.append(
                {
                    "class": type(file).__name__,
                    "name": file.name,
                    "mimeType": file.mime_type,
                    "artifactId": artifact.artifact_id,
                    **transfer,
                }
            )
    return verdicts


async def client_mode(base_url: str, temp_dir: Path) -> None:
    """Drive the JavaScript bridge through the public Python 0.3.2 APIs."""
    version = assert_package_version()
    async with httpx.AsyncClient(timeout=20.0) as http_client:
        card = await A2ACardResolver(http_client, base_url).get_agent_card()
        client = ClientFactory(
            ClientConfig(httpx_client=http_client, streaming=True)
        ).create(card)

        terminal: Task | None = None
        mixed = message(
            "python-files",
            [
                Part(root=TextPart(text="python-files")),
                Part(root=DataPart(data={"source": "python", "order": 2})),
                Part(root=FilePart(file=FileWithBytes(
                    bytes=base64.b64encode(PYTHON_INPUT_INLINE).decode("ascii"),
                    name="python-inline.bin",
                    mime_type="application/x-python-inline",
                ))),
                Part(root=FilePart(file=FileWithUri(
                    uri=f"{base_url}/fixture-input/large",
                    name="python-uri.bin",
                    mime_type="application/x-python-uri",
                ))),
            ],
        )
        async for event in client.send_message(mixed):
            candidate = task_from_event(event)
            if candidate is not None:
                terminal = candidate
        if terminal is None:
            raise RuntimeError("Python client did not receive a Task")

        fetched = await client.get_task(TaskQueryParams(id=terminal.id))
        input_verdict = next(
            part.root.data
            for artifact in terminal.artifacts or []
            for part in artifact.parts
            if isinstance(part.root, DataPart)
        )
        output_files = await task_file_verdicts(terminal, temp_dir)

        cancel_stream = client.send_message(message("python-cancel"))
        first = await anext(cancel_stream)
        cancel_task = task_from_event(first)
        if cancel_task is None:
            raise RuntimeError("Python cancellation stream did not begin with a Task")
        canceled = await client.cancel_task(TaskIdParams(id=cancel_task.id))
        await cancel_stream.aclose()

        question = None
        async for event in client.send_message(message("python-question")):
            question = task_from_event(event) or question
        assert question is not None
        assert question.status.message is not None
        text = next(part.root.text for part in question.status.message.parts if isinstance(part.root, TextPart))
        data = next(part.root.data for part in question.status.message.parts if isinstance(part.root, DataPart))
        looked_up = await client.get_task(TaskQueryParams(id=question.id))
        answer = message("", [Part(root=DataPart(data=ANSWER_DATA))])
        answer.task_id = question.id
        answer.context_id = question.context_id
        completed = None
        async for event in client.send_message(answer):
            completed = task_from_event(event) or completed
        assert completed is not None
        interaction = {
            "state": question.status.state.value, "lookupState": looked_up.status.state.value,
            "text": text, "data": data, "sameTask": completed.id == question.id,
            "sameContext": completed.context_id == question.context_id,
            "completedState": completed.status.state.value, "output": task_text(completed),
        }

        print(
            json.dumps(
                {
                    "packageVersion": version,
                    "output": task_text(terminal),
                    "input": input_verdict,
                    "outputFiles": output_files,
                    "lookupState": fetched.status.state.value,
                    "canceledState": canceled.status.state.value,
                    "interaction": interaction,
                }
            ),
            flush=True,
        )


class EchoExecutor(AgentExecutor):
    """Python 0.3.2 Agent serving files and a resumable question."""

    def __init__(self, base_url: str, temp_dir: Path):
        self.base_url = base_url
        self.temp_dir = temp_dir

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.submit()
        await updater.start_work()
        if context.message is None:
            raise RuntimeError("missing input message")
        first = context.message.parts[0].root
        if isinstance(first, TextPart) and first.text == "javascript-question":
            await updater.update_status(TaskState.input_required, message=Message(
                role=Role.agent, message_id=str(uuid.uuid4()),
                task_id=context.task_id, context_id=context.context_id,
                parts=[
                    Part(root=TextPart(text="Select the environment")),
                    Part(root=DataPart(data=QUESTION_DATA)),
                    Part(root=FilePart(file=FileWithBytes(
                        bytes=base64.b64encode(b"Choose safely.").decode("ascii"),
                        name="question-guide.txt", mime_type="text/plain",
                    ))),
                ],
            ), final=True)
            return
        if isinstance(first, DataPart):
            assert first.data == ANSWER_DATA
            assert context.current_task is not None
            assert context.current_task.status.state == TaskState.input_required
            await updater.add_artifact(
                [Part(root=TextPart(text=f"selected:{first.data['answers'][0]['selected'][0]}"))],
                artifact_id="python-answer", last_chunk=True,
            )
            await updater.complete()
            return
        input_parts: list[dict[str, Any]] = []
        for index, part in enumerate(context.message.parts):
            root = part.root
            if isinstance(root, TextPart):
                input_parts.append({"kind": "text", "text": root.text})
            elif isinstance(root, DataPart):
                input_parts.append({"kind": "data", "data": root.data})
            elif isinstance(root, FilePart):
                file = root.file
                if isinstance(file, FileWithBytes):
                    data = base64.b64decode(file.bytes, validate=True)
                    transfer = {"bytes": len(data), "sha256": digest(data)}
                elif isinstance(file, FileWithUri):
                    transfer = await download_verdict(
                        file.uri, self.temp_dir / f"python-server-input-{index}.bin"
                    )
                else:
                    raise RuntimeError(f"unexpected file class {type(file).__name__}")
                input_parts.append({
                    "kind": "file",
                    "class": type(file).__name__,
                    "name": file.name,
                    "mimeType": file.mime_type,
                    **transfer,
                })
            else:
                raise RuntimeError(f"unexpected Part {type(root).__name__}")
        await updater.add_artifact(
            [
                Part(root=DataPart(data={"inputParts": input_parts})),
                Part(root=FilePart(file=FileWithBytes(
                    bytes=base64.b64encode(PYTHON_OUTPUT_INLINE).decode("ascii"),
                    name="python-output-inline.bin",
                    mime_type="application/x-python-output-inline",
                ))),
                Part(root=FilePart(file=FileWithUri(
                    uri=f"{self.base_url}/files/python-output-uri.bin",
                    name="python-output-uri.bin",
                    mime_type="application/x-python-output-uri",
                ))),
            ],
            artifact_id="python-files",
            name="result",
            last_chunk=True,
        )
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel()


async def server_mode(temp_dir: Path) -> None:
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
        default_input_modes=["text/plain", "application/json", "application/octet-stream"],
        default_output_modes=["application/json", "application/octet-stream"],
        skills=[AgentSkill(
            id="interop",
            name="Interop",
            description="Echo interoperability requests",
            tags=["test"],
        )],
    )
    handler = DefaultRequestHandler(
        agent_executor=EchoExecutor(base_url, temp_dir),
        task_store=InMemoryTaskStore(),
    )
    app = A2AStarletteApplication(agent_card=card, http_handler=handler).build(
        rpc_url="/a2a"
    )
    async def output_file(_request: Any) -> Response:
        return Response(PYTHON_OUTPUT_URI, media_type="application/octet-stream")

    app.add_route("/files/python-output-uri.bin", output_file, methods=["GET"])
    class ReadyServer(uvicorn.Server):
        """Publish readiness only after the owned socket is serving."""

        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets=sockets)
            if self.started:
                print(json.dumps({"baseUrl": base_url, "packageVersion": EXPECTED_VERSION}), flush=True)

    server = ReadyServer(uvicorn.Config(app, log_level="warning", lifespan="off"))

    async def stop_on_stdin_close() -> None:
        await asyncio.to_thread(sys.stdin.buffer.read)
        server.should_exit = True

    shutdown = asyncio.create_task(stop_on_stdin_close())
    try:
        await server.serve(sockets=[listener])
    finally:
        listener.close()
        shutdown.cancel()
        await asyncio.gather(shutdown, return_exceptions=True)


def main() -> None:
    """Dispatch the requested fixture mode."""
    if len(sys.argv) == 4 and sys.argv[1] == "client":
        temp_dir = Path(sys.argv[3]).resolve()
        temp_dir.mkdir(parents=True, exist_ok=True)
        asyncio.run(asyncio.wait_for(client_mode(sys.argv[2].rstrip("/"), temp_dir), timeout=25.0))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "server":
        temp_dir = Path(sys.argv[2]).resolve()
        temp_dir.mkdir(parents=True, exist_ok=True)
        asyncio.run(server_mode(temp_dir))
        return
    raise SystemExit(
        "usage: a2a-python-v032-peer.py client BASE_URL TEMP_DIR | server TEMP_DIR"
    )


if __name__ == "__main__":
    main()
