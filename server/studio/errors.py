"""Uniform error envelope: {"error": {"code", "message"}}."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra  # 併進 error body 的額外欄位（例：retry_after）


def not_found(what: str = "resource") -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def forbidden(msg: str = "forbidden") -> ApiError:
    return ApiError(403, "forbidden", msg)


def bad_request(msg: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, msg)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        body = {"error": {"code": exc.code, "message": exc.message, **(exc.extra or {})}}
        headers = {"Retry-After": str(exc.extra["retry_after"])} if exc.extra and "retry_after" in exc.extra else None
        return JSONResponse(body, status_code=exc.status, headers=headers)

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException):
        code = {401: "unauthorized", 403: "forbidden", 404: "not_found"}.get(exc.status_code, "http_error")
        return JSONResponse({"error": {"code": code, "message": str(exc.detail)}}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse({"error": {"code": "validation_error", "message": str(exc.errors())}}, status_code=422)
