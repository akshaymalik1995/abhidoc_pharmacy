"""Shapes more than one screen answers with."""
from pydantic import BaseModel


class Choice(BaseModel):
    """One entry of a dropdown."""
    value: str
    label: str
