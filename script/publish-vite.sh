#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -eou pipefail

# Configuration
PROJECT="apo-to-camilla"
STACK_NAME_CLOUDFRONT="cfn-$PROJECT-cloudfront"
APP_FOLDER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$APP_FOLDER/dist"
S3_BUCKET="s3://s3-$PROJECT-cloudfront-ec1/"
AWS_PROFILE="experiatis"
AWS_DEFAULT_REGION="eu-central-1"
DRYRUN=0

# Parse command line arguments
while getopts "dp:r:h" opt; do
  case $opt in
    d) DRYRUN=1 ;;
    p) AWS_PROFILE="$OPTARG" ;;
    r) AWS_DEFAULT_REGION="$OPTARG" ;;
    h)
      echo "Usage: $0 [-d] [-p profile] [-r region]"
      echo "  -d: Dry run mode"
      echo "  -p: AWS profile (default: experiatis)"
      echo "  -r: AWS region (default: eu-central-1)"
      exit 0
      ;;
    *) exit 1 ;;
  esac
done

# Export AWS settings
export AWS_PROFILE AWS_DEFAULT_REGION

# Function to sync files to S3
sync_to_s3()
{
  echo "Syncing files to S3 bucket..."
  local cmd="aws s3 sync --delete --no-progress --size-only --cache-control \"max-age=3600\" \"$HOME_DIR/\" \"$S3_BUCKET\""

  if [[ "$DRYRUN" = 1 ]]; then
    cmd="$cmd --dryrun"
  fi

  echo "$cmd"
  eval "$cmd"
}

# Function to invalidate CloudFront cache
invalidate_cache()
{
  echo "Getting distribution ID from CloudFormation..."
  local distribution_id
  distribution_id=$(aws cloudformation list-exports \
    --query "Exports[?Name=='$STACK_NAME_CLOUDFRONT-Distribution'].Value" --output text)

  echo "Invalidating CloudFront cache..."
  if [[ "$DRYRUN" = 0 ]]; then
    local invalidation_output
    invalidation_output=$(aws cloudfront create-invalidation \
      --distribution-id "$distribution_id" \
      --paths '/*')

    echo "$invalidation_output"

    echo "Waiting for invalidation to complete..."
    local invalidation_id
    invalidation_id=$(echo "$invalidation_output" | jq -r '.Invalidation.Id')

    aws cloudfront wait invalidation-completed \
      --distribution-id "$distribution_id" \
      --id "$invalidation_id"
  else
    echo "aws cloudfront create-invalidation --distribution-id $distribution_id --paths '/*' (dry run)"
  fi
}

# Main execution
main()
{
  sync_to_s3
  invalidate_cache

  echo "Successfully deployed!"
  echo "Visit https://sangoku.work/ to see the changes."
}

main
exit 0
