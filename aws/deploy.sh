#!/bin/sh
# Sets up, or brings up to date, the Family Graph website on AWS, then says where it is.
#
#   ALARM_EMAIL=you@example.com aws/deploy.sh
#
# Needs the AWS CLI, signed in. Everything is made in one stack (template.yml), in the region below,
# apart from one small bucket that holds the service's code on its way in.
set -eu
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-southeast-2}"
STACK="${STACK:-family-graph}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CODE="$STACK-code-$ACCOUNT-$REGION"
aws s3api head-bucket --bucket "$CODE" 2>/dev/null || aws s3 mb "s3://$CODE" >/dev/null

echo "Setting up the stack $STACK in $REGION (the first time takes several minutes)..."
aws cloudformation package --template-file aws/template.yml --s3-bucket "$CODE" --output-template-file dist/cloud.packaged.yml >/dev/null
aws cloudformation deploy --template-file dist/cloud.packaged.yml --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "AlarmEmail=${ALARM_EMAIL:?Set ALARM_EMAIL to where cost warnings should go}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

echo "Building the page..."
CLOUD_REGION="$REGION" CLOUD_CLIENT_ID="$(out ClientId)" node web/build.js cloud

echo "Sending the page..."
aws s3 sync dist/cloud "s3://$(out PageBucket)" --delete --only-show-errors
# The address keeps its own copy of the page for a day; tell it there is a new one.
aws cloudfront create-invalidation --distribution-id "$(out SiteId)" --paths '/*' --query Invalidation.Id --output text >/dev/null

echo "The website is at $(out Address)"
