#!/usr/bin/env bash

set -euo pipefail

# Fixed configuration per project
AWS_PROFILE="devops-sandbox"
AWS_REGION="ap-southeast-2"

# Image coordinates
IMAGE_NAME="demo-node-app"
# Default tag to git SHA if available, otherwise 'latest'; allow override via env
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"

# Resolve account id
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$AWS_PROFILE")

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
REPOSITORY_URI="${ECR_URI}/${IMAGE_NAME}"

echo "Using AWS profile: $AWS_PROFILE"
echo "Using AWS region:  $AWS_REGION"
echo "AWS account id:   $AWS_ACCOUNT_ID"
echo "Repository URI:   $REPOSITORY_URI"
echo "Image tag:        $IMAGE_TAG"

# Ensure repository exists (idempotent)
aws ecr describe-repositories \
  --repository-names "$IMAGE_NAME" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" >/dev/null 2>&1 || {
  echo "ECR repository '$IMAGE_NAME' not found. Creating..."
  aws ecr create-repository \
    --repository-name "$IMAGE_NAME" \
    --image-scanning-configuration scanOnPush=true \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" >/dev/null
}

echo "Logging in to ECR..."
aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" | \
  docker login --username AWS --password-stdin "$ECR_URI"

echo "Building image..."
docker build -t "$IMAGE_NAME:$IMAGE_TAG" .

echo "Tagging image..."
docker tag "$IMAGE_NAME:$IMAGE_TAG" "$REPOSITORY_URI:$IMAGE_TAG"

echo "Pushing image to ECR..."
docker push "$REPOSITORY_URI:$IMAGE_TAG"

echo "Pushed: $REPOSITORY_URI:$IMAGE_TAG"


