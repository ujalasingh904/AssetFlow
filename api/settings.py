import os
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class Input(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class RepairDraft(Input):
    category: Literal["Electrical", "Mechanical", "Cosmetic", "Other"]
    priority: Literal["Low", "Normal", "High"]
    summary: str = Field(min_length=1, max_length=400)
    next_step: str = Field(min_length=1, max_length=400)


def today():
    return datetime.now(ZoneInfo(os.getenv("BUSINESS_TIMEZONE", "Asia/Kolkata"))).date()


def missing(label):
    raise HTTPException(404, f"{label} not found.")
