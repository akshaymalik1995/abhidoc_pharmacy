"""Small pieces of SQL every screen needs."""


def like(text: str) -> str:
    """User search text as a LIKE pattern in which percent, underscore and backslash mean themselves.

    Use it with ESCAPE and a backslash in the SQL.
    """
    return "%" + text.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
