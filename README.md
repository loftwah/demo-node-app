## Loftwah's Demo Node App

This repository contains a minimal TypeScript Node.js 20 web application that demonstrates CRUD operations across S3, RDS Postgres, and ElastiCache Redis. It is packaged for both ECS and EKS from a single repository.

### About me

I am Loftwah. I build things, break things, and then document how to put them back together so we can ship faster next time. I write at [blog.deanlofts.xyz](https://blog.deanlofts.xyz). This repo is a compact demo I use to validate end to end integrations before committing to infrastructure decisions.

### Endpoints

- `GET /healthz` returns a JSON object with overall status and the status of S3, Postgres, and Redis.
- S3 CRUD at `POST|GET|DELETE /s3/:id` storing objects at `s3://$S3_BUCKET/app/<id>.txt`.
- Postgres CRUD at `POST|GET|PUT|DELETE /db/items[/:id]` with a table schema `items(id uuid, name text, value jsonb, created_at timestamptz)`.
- Redis CRUD at `POST|GET|PUT|DELETE /cache/:key`.
- `GET /selftest` runs a one-off self-test that exercises CRUD across all three services and returns a summary.

### Authentication

If no `Authorization` header is provided, the request is treated as if made by user `loftwah`. The `Authorization` values `Bearer demo` or `loftwah:hunter2` are also accepted and set the user to `loftwah`.

### Self-test

At startup, the app can run an automated self-test that:

- Writes, reads, and deletes an S3 object in bucket `$S3_BUCKET`.
- Creates, reads, updates, and deletes a Postgres row in the `items` table.
- Sets, gets, and deletes a Redis key.

Enable or disable:

- Environment variable `SELF_TEST_ON_BOOT=true|false`. Default is `true`.

Run on demand:

```bash
curl -s http://<host>:3000/selftest | jq
```

Logs:

- The app logs each self-test step with tags `[selftest][s3]`, `[selftest][db]`, and `[selftest][redis]`, and a final summary.

### Local Development with Docker Compose

1. Start the stack.

```bash
docker compose up --build -d
```

2. Verify health.

```bash
curl -s localhost:3000/healthz | jq
```

3. Exercise CRUD locally.

```bash
# S3
curl -s -X POST localhost:3000/s3/banana -H 'Content-Type: application/json' -d '{"text":"hello from Loftwah"}' | jq
curl -s localhost:3000/s3/banana
curl -s -X DELETE localhost:3000/s3/banana | jq

# Postgres
curl -s -X POST localhost:3000/db/items -H 'Content-Type: application/json' -d '{"name":"banana","value":{"tasty":true}}' | tee /tmp/item.json; echo
ID=$(jq -r .id /tmp/item.json)
curl -s localhost:3000/db/items | jq
curl -s localhost:3000/db/items/$ID | jq
curl -s -X PUT localhost:3000/db/items/$ID -H 'Content-Type: application/json' -d '{"name":"banana-2","value":{"updated":true}}' | jq
curl -s -X DELETE localhost:3000/db/items/$ID | jq

# Redis
curl -s -X POST localhost:3000/cache/greeting -H 'Content-Type: application/json' -d '{"value":"hello loftwah"}' | jq
curl -s localhost:3000/cache/greeting
curl -s -X PUT localhost:3000/cache/greeting -H 'Content-Type: application/json' -d '{"value":"yo loftwah"}' | jq
curl -s -X DELETE localhost:3000/cache/greeting | jq
```

### Running without Docker Compose

```bash
npm ci
npm run build
npm start
```

### Docker Build and Run

```bash
docker build -t demo-node-app:local .
docker run --rm -p 3000:3000 \
  -e APP_ENV=local -e LOG_LEVEL=debug -e PORT=3000 \
  -e S3_BUCKET=local-bucket -e AWS_REGION=us-east-1 \
  -e DB_HOST=host.docker.internal -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASS=postgres -e DB_NAME=app -e DB_SSL=disable \
  -e REDIS_HOST=host.docker.internal -e REDIS_PORT=6379 \
  -e SELF_TEST_ON_BOOT=false \
  demo-node-app:local
```

### ECS Buildspec

The file `buildspec.yml` builds the TypeScript code, builds and pushes a Docker image tagged with `staging` and with the current git commit SHA, and emits an `imagedefinitions.json` file for ECS deployment.

### CI with GitHub Actions (optional)

The workflow at `.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It performs type checking and builds the project. If a `GHCR_PAT` secret is configured, it also builds and pushes a Docker image to GitHub Container Registry (GHCR) using the tags `staging` (on `main`) and the short git SHA.

Note: Deployment to AWS is handled by CodePipeline/CodeBuild/CodeDeploy using `buildspec.yml`. The GitHub Actions workflow is build-only and optional.

### EKS Helm Chart

The Helm chart in `deploy/eks/chart` deploys the application with a Deployment, Service, Ingress for ALB, and a Secret. Set `image.repository` in `values.yaml` to your ECR repository. Configure database and Redis endpoints and secrets in `values.yaml`.

### Helm values stub

Use `deploy/eks/chart/values-stub.yaml` as a starting point. It includes prefilled known values and TODOs for RDS and ElastiCache. Example usage:

```bash
helm upgrade --install demo-node-app deploy/eks/chart \
  --namespace demo --create-namespace \
  -f deploy/eks/chart/values-stub.yaml
```

### Configuration

- `APP_ENV` (default `staging`), `LOG_LEVEL`, `PORT`
- `S3_BUCKET`, `AWS_REGION`
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SSL` (required or disable)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASS`
- `SELF_TEST_ON_BOOT` (default `true`)

### OpenTelemetry Tracing

This app includes basic OpenTelemetry auto-instrumentation for HTTP/Express, Postgres (`pg`), and Redis (`ioredis`). Configure these env vars to export traces:

- `OTEL_SERVICE_NAME` (default `demo-node-app`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://otel-collector.observability:4318`)
- Optional: `OTEL_EXPORTER_OTLP_HEADERS` (e.g., `Authorization=Bearer <token>`)

Kubernetes with the included Collector:

```
kubectl apply -f aws-labs/kubernetes/manifests/otel-collector-gateway.yml
```

Ensure your Deployment or container env sets `OTEL_EXPORTER_OTLP_ENDPOINT` to the Collector service (above default works when running in-cluster).

### Domains

- ECS: `demo-node-app-ecs.aws.deanlofts.xyz`
- EKS: `demo-node-app-eks.aws.deanlofts.xyz`

### AWS Validation Steps

The following outline demonstrates that each service is used in AWS. Replace placeholders with actual values or export them as environment variables.

1. S3 validation on AWS

- Ensure the task or pod has access to S3 and that `S3_BUCKET` is set to an existing bucket.
- Run curl against the service to write, read, and delete an object.

```bash
curl -s -X POST https://<domain>/s3/demo -H 'Content-Type: application/json' -d '{"text":"hello from Loftwah on AWS"}'
curl -s https://<domain>/s3/demo
curl -s -X DELETE https://<domain>/s3/demo
```

2. RDS Postgres validation on AWS

- Point `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SSL` to your RDS instance.
- Use curl to create, read, update, and delete an item.

```bash
curl -s -X POST https://<domain>/db/items -H 'Content-Type: application/json' -d '{"name":"aws-item","value":{"cloud":true}}' | tee /tmp/aws-item.json
ID=$(jq -r .id /tmp/aws-item.json)
curl -s https://<domain>/db/items/$ID
curl -s -X PUT https://<domain>/db/items/$ID -H 'Content-Type: application/json' -d '{"name":"aws-item-2","value":{"updated":true}}'
curl -s -X DELETE https://<domain>/db/items/$ID
```

3. ElastiCache Redis validation on AWS

- Point `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASS` to your Redis endpoint.
- Use curl to set, get, and delete a key.

```bash
curl -s -X POST https://<domain>/cache/ping -H 'Content-Type: application/json' -d '{"value":"hello aws"}'
curl -s https://<domain>/cache/ping
curl -s -X DELETE https://<domain>/cache/ping
```

### Proving usage

- S3 usage is proven by successful write, read, and delete of objects via the `/s3` endpoint path.
- RDS usage is proven by creating the `items` table on boot if it does not exist and by CRUD operations via the `/db/items` endpoints.
- Redis usage is proven by successful set, get, and delete operations via the `/cache` endpoints and by the application health check ping.
