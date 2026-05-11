terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

locals {
  repos = [var.backend_repo, var.frontend_repo]
}

# stage: require PR, no force push, no direct commits
resource "github_branch_protection" "stage" {
  for_each = toset(local.repos)

  repository_id = each.value
  pattern       = "stage"

  required_pull_request_reviews {
    required_approving_review_count = 0
  }

  allows_force_pushes = false
  allows_deletions    = false
}

# master: require PR + passing CI, no force push
resource "github_branch_protection" "master" {
  for_each = toset(local.repos)

  repository_id = each.value
  pattern       = "master"

  required_pull_request_reviews {
    required_approving_review_count = 1
  }

  required_status_checks {
    strict   = true
    contexts = ["ci"]
  }

  allows_force_pushes = false
  allows_deletions    = false
}
