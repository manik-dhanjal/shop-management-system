# Deployment Guide

Three environments — **dev**, **stage**, **prod** — provisioned via Terraform on free-tier services.

## Services

| Component | Service | Free tier |
|-----------|---------|-----------|
| Backend ×3 | [Render](https://render.com) | 750 hrs/month shared; sleeps after 15 min idle |
| Frontend | [Vercel](https://vercel.com) | Unlimited hobby deployments |
| Database | [MongoDB Atlas](https://cloud.mongodb.com) | 1 M0 cluster, 512 MB storage |

## Branch → Environment mapping

| Branch | Environment | Backend | Frontend |
|--------|-------------|---------|----------|
| `develop` | Dev | Render `sms-dev` | Vercel preview |
| `stage` | Stage | Render `sms-stage` | Vercel preview |
| `master` | Prod | Render `sms-prod` | Vercel production |

## One-time setup

### 1. Prerequisites

Install tools:

```bash
brew install terraform gh
```

Log in to GitHub CLI:

```bash
gh auth login
```

### 2. Collect API keys

| Key | Where to find it |
|-----|-----------------|
| `atlas_org_id` | Atlas → Organizations → Settings |
| `atlas_public_key` / `atlas_private_key` | Atlas → Access Manager → API Keys → Create |
| `render_api_key` | Render → Account Settings → API Keys |
| `render_owner_id` | Render → Account Settings → owner ID (starts with `usr-` or `tea-`) |
| `vercel_api_token` | Vercel → Settings → Tokens |
| `github_token` | GitHub → Settings → Developer settings → PAT (scopes: `repo`, `admin:repo_hook`) |

App secrets come from your local `.env` file.

### 3. Fill in tfvars

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
# edit infra/terraform.tfvars with real values
```

### 4. Apply

```bash
cd infra
terraform init
terraform plan   # review what will be created
terraform apply
```

Terraform prints the backend and frontend URLs when done.

### 5. Configure Vercel GitHub integration

Vercel needs permission to deploy from GitHub. On first run, visit the Vercel dashboard and connect the GitHub app to the `shop-management-system-ui` repository.

## Upgrading prod from free tier

If cold-start latency on Render becomes a problem for prod users, upgrade `sms-prod` to the $7/month Starter plan in the Render dashboard — no Terraform change needed.

## Day-to-day workflow

```
feature/* → develop (auto-deploys to dev)
develop   → stage   (monthly; triggers regression on stage)
stage     → master  (release; deploys to prod)
```

`stage` and `master` require a pull request. `master` additionally requires one approving review and a passing CI check.

## Tearing down

```bash
cd infra
terraform destroy
```

This deletes all Render services, the Vercel project, Atlas cluster, and branch protection rules. MongoDB data is lost. The GitHub repos themselves are not deleted.
