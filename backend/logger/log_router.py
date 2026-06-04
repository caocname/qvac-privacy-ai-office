import json as _json

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogExportResponse, LogType

router = APIRouter(prefix="/api/v1/log", tags=["audit-log"])

_CSV_HEADER = "log_id,absolute_datetime,relative_timestamp_ms,log_type,metrics,payload_snapshot\r\n"


def _logs_to_csv(items) -> str:
    """将 LogExportItem 列表转为 CSV 字符串。"""
    lines = [_CSV_HEADER]
    for item in items:
        payload = (item.payload_snapshot or "").replace('"', '""')
        metrics_str = ""
        if item.metrics:
            metrics_str = _json.dumps(item.metrics, ensure_ascii=False).replace('"', '""')
        lines.append(
            f'"{item.log_id}","{item.absolute_datetime}",{item.relative_timestamp_ms},'
            f'"{item.log_type}","{metrics_str}","{payload}"\r\n'
        )
    return "".join(lines)


@router.get("/export", response_model=LogExportResponse)
async def export_logs(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=1000, description="每页条数，上限 1000"),
    format: str = Query("json", description="导出格式: json | csv"),
    api_version: str = Query("v1", description="API 版本"),
):
    """审计日志分页查询与导出接口。"""
    logger = get_audit_logger()
    items, total = logger.export(page=page, page_size=page_size)

    logger.log(LogType.EXPORT, {
        "event": "audit_log_exported",
        "format": format,
        "total_records": total,
        "page": page,
        "page_size": page_size,
    })

    if format == "csv":
        csv_content = _logs_to_csv(items)
        return PlainTextResponse(
            content=csv_content,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=audit-log-page{page}.csv"},
        )

    return LogExportResponse(
        api_version=api_version,
        total_records=total,
        page=page,
        logs=[item.model_dump() for item in items],
    )


@router.get("/export/all")
async def export_all_logs(
    format: str = Query("json", description="导出格式: json | csv"),
    api_version: str = Query("v1", description="API 版本"),
):
    """审计日志全量导出 — 无分页，返回所有记录。"""
    logger = get_audit_logger()
    items, total = logger._db.query_all()

    logger.log(LogType.EXPORT, {
        "event": "audit_log_full_export",
        "format": format,
        "total_records": total,
    })

    if format == "csv":
        csv_content = _logs_to_csv(items)
        return PlainTextResponse(
            content=csv_content,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=audit-log-full.csv"},
        )

    return {
        "api_version": api_version,
        "total_records": total,
        "logs": [item.model_dump() for item in items],
    }
