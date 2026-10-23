# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
ARG LITELLM_VERSION=1.106.0
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp
RUN pip install --no-cache-dir "litellm[proxy,mcp]==${LITELLM_VERSION}"
WORKDIR /app
CMD ["litellm", "--config", "/config/config.yaml", "--host", "0.0.0.0", "--port", "4000"]
