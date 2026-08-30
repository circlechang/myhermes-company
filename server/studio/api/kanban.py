from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ..auth import Principal, current_principal
from ..errors import ApiError
from ..hermes.cli import CliError

router = APIRouter(tags=["kanban"])


def _wrap(e: CliError) -> ApiError:
    return ApiError(502, "hermes_cli_error", str(e))


@router.get("/kanban/tasks")
async def list_tasks(request: Request, status: Optional[str] = None, p: Principal = Depends(current_principal)):
    try:
        return await request.app.state.cli.kanban_list(status)
    except CliError as e:
        raise _wrap(e)


class TaskCreate(BaseModel):
    title: str
    body: str = ""
    assignee: str = ""
    priority: Optional[int] = None


@router.post("/kanban/tasks", status_code=201)
async def create_task(body: TaskCreate, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await request.app.state.cli.kanban_create(body.title, body.body, body.assignee, body.priority)
    except CliError as e:
        raise _wrap(e)


class StatusBody(BaseModel):
    status: str


@router.post("/kanban/tasks/{task_id}/status")
async def set_status(task_id: str, body: StatusBody, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await request.app.state.cli.kanban_set_status(task_id, body.status)
    except CliError as e:
        raise _wrap(e)


class CommentBody(BaseModel):
    text: str


@router.post("/kanban/tasks/{task_id}/comment")
async def comment(task_id: str, body: CommentBody, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await request.app.state.cli.kanban_comment(task_id, body.text)
    except CliError as e:
        raise _wrap(e)
