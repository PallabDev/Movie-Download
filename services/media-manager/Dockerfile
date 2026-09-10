FROM python:3.13-alpine

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN apk add --no-cache ffmpeg unzip && pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY worker.py .
COPY templates ./templates
COPY static ./static


EXPOSE 5687
CMD ["gunicorn", "--bind", "0.0.0.0:5687", "--workers", "1", "--threads", "4", "--timeout", "0", "app:app"]
