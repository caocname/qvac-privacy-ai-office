from fastapi import APIRouter, Query

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogExportResponse

router = APIRouter(prefix="/api/v1/log", tags=["audit-log"])


@router.get("/export", response_model=LogExportResponse)
async def export_logs(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=200, description="每页条数，上限 200"),
    api_version: str = Query("v1", description="API 版本"),
):
    """审计日志分页查询与导出接口。

    返回结构包含：
    - 单调递增的 relative_timestamp_ms（自系统初始化以来的毫秒数）
    - ISO-8601 格式的 absolute_datetime
    - 完整的 metrics 指标快照与 payload_snapshot 文本摘要
    """
    logger = get_audit_logger()
    items, total = logger.export(page=page, page_size=page_size)
    return LogExportResponse(
        api_version=api_version,
        total_records=total,
        page=page,
        logs=[item.model_dump() for item in items],
    )
