FROM python:3.12-slim-bookworm

# Install uv for ultra-fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Environment variables
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Copy dependency specifications
COPY pyproject.toml uv.lock ./

# Install dependencies using uv sync without dev packages
RUN uv sync --frozen --no-dev --no-install-project

# Copy the rest of the application
COPY . .

# Install project itself
RUN uv sync --frozen --no-dev

# Expose port
EXPOSE 8000

# Start FastAPI via uvicorn
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
