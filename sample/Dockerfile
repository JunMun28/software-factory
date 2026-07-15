# Produced-app image (Plan B3). The factory's kaniko build Job turns the merged
# main of a per-request workspace into this image. Arbitrary-UID conventions
# (root group ownership, chmod g=u, HOME=/app) so app pods run non-root under a
# forced UID, matching the factory's restricted-SCC emulation (spec §2).
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONPATH=/app/src HOME=/app
RUN chgrp -R 0 /app && chmod -R g=u /app
EXPOSE 8000
USER 10101
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
