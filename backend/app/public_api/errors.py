"""开放 API 的结构化错误（03 文档 ToolError 风格，信封见 09 标准文档）。"""
from fastapi import Request
from fastapi.responses import JSONResponse


class PublicApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field: str | None = None,
        retryable: bool = False,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field
        self.retryable = retryable
        self.headers = headers or {}


def error_body(code: str, message: str, field: str | None, retryable: bool) -> dict:
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "field": field,
            "retryable": retryable,
        },
    }


async def public_api_error_handler(_request: Request, exc: PublicApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content=error_body(exc.code, exc.message, exc.field, exc.retryable),
        headers=exc.headers,
    )
