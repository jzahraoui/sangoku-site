#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -eou pipefail

# Configuration
PROJECT="apo-to-camilla"
APP_FOLDER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOLDER_LIST=("ressources" "img" "css")
DEST_DIR="$APP_FOLDER/public"
S3_BUCKET="s3://s3-$PROJECT-cloudfront-ec1"
AWS_PROFILE="experiatis"
AWS_DEFAULT_REGION="eu-central-1"
DRYRUN=0
DELETE_FLAG=0
PULL_OR_PUSH="pull" # Default action is pull

# Parse command line arguments
while getopts "dfa:p:r:h" opt; do
  case $opt in
    d) DRYRUN=1 ;;
    f) DELETE_FLAG=1 ;;
    a) PULL_OR_PUSH="$OPTARG" ;;
    p) AWS_PROFILE="$OPTARG" ;;
    r) AWS_DEFAULT_REGION="$OPTARG" ;;
    h)
      echo "Usage: $0 [-d] [-f] [-a action] [-p profile] [-r region]"
      echo "  -d: Dry run mode"
      echo "  -f: Delete files from S3 bucket"
      echo "  -a: Action to perform: pull or push (default: pull)"
      echo "  -p: AWS profile (default: experiatis)"
      echo "  -r: AWS region (default: eu-central-1)"
      exit 0
      ;;
    *) exit 1 ;;
  esac
done

# Export AWS settings
export AWS_PROFILE AWS_DEFAULT_REGION

pull_from_s3()
{
  echo "Syncing files from S3 bucket..."
  for folder in "${FOLDER_LIST[@]}"; do
    local cmd="aws s3 sync --no-progress --size-only \"$S3_BUCKET/$folder\" \"$DEST_DIR/$folder\""

    if [[ "$DRYRUN" = 1 ]]; then
      cmd="$cmd --dryrun"
    fi

    if [[ "$DELETE_FLAG" = 1 ]]; then
      cmd="$cmd --delete"
    fi

    echo "$cmd"
    eval "$cmd"
  done
  return 0
}

push_to_s3()
{
  echo "Syncing files to S3 bucket..."
  for folder in "${FOLDER_LIST[@]}"; do
    local cmd="aws s3 sync --no-progress --size-only --cache-control \"max-age=3600\" \"$DEST_DIR/$folder\" \"$S3_BUCKET/$folder\""

    if [[ "$DRYRUN" = 1 ]]; then
      cmd="$cmd --dryrun"
    fi

    if [[ "$DELETE_FLAG" = 1 ]]; then
      cmd="$cmd --delete"
    fi

    echo "$cmd"
    eval "$cmd"
  done
  return 0
}

# Main execution
main()
{
  if [[ "$PULL_OR_PUSH" == "pull" ]]; then
    pull_from_s3
    echo "Successfully pulled resources from S3!"
  elif [[ "$PULL_OR_PUSH" == "push" ]]; then
    push_to_s3
    echo "Successfully pushed resources to S3!"
  else
    echo "Invalid action: $PULL_OR_PUSH. Use 'pull' or 'push'."
    exit 1
  fi
  return 0
}

main
exit 0
