# Deployment Guide

Three environments provisioned via Terraform on free-tier services.

## Live URLs

| Environment | Frontend | Backend |
|-------------|----------|---------|
| **Dev** | https://shop-management-system-git-develop-manikdhanjals-projects.vercel.app | https://sms-dev.onrender.com |
| **Stage** | https://shop-management-system-git-stage-manikdhanjals-projects.vercel.app | https://sms-stage-9e8p.onrender.com |
| **Prod** | https://shop-management-system.vercel.app | https://sms-prod.onrender.com |

## Services

| Component | Service | Free tier |
|-----------|---------|-----------|
| Backend ×3 | [Render](https://render.com) | 750 hrs/month shared; sleeps after 15 min idle |
| Frontend | [Vercel](https://vercel.com) | Unlimited hobby deployments |
| Database | [MongoDB Atlas](https://cloud.mongodb.com) | M0 cluster, 512 MB storage |

---

## Day-to-day workflow

### Developing a feature (→ Dev)

```bash
# 1. Branch off develop
git checkout develop
git pull origin develop
git checkout -b feature/my-feature

# 2. Make changes, commit, push
git push origin feature/my-feature

# 3. Open a PR into develop on GitHub
# Once merged → Render sms-dev and Vercel dev preview auto-deploy
```

### Promoting to Stage (monthly regression)

```bash
# Open a PR from develop → stage on GitHub
# Merge after review → Render sms-stage and Vercel stage preview auto-deploy
# Run regression testing on the stage URLs above
```

### Releasing to Production

```bash
# Open a PR from stage → master on GitHub
# Requires: 1 approving review + passing CI
# Merge → Render sms-prod and Vercel production auto-deploy
```

> **Branch protection summary:**
> - `stage` — PR required, no force push
> - `master` — PR required, 1 approving review, CI must pass, no force push

---

## Seeding a database

The seed script creates the demo shop, admin user, 5 products, and 5 customers. It is idempotent — safe to run multiple times.

```bash
# Install seed dependencies once
cd docker/seed && npm install

# Seed a specific environment
MONGO_URL="<connection-string>" node docker/seed/seed.js
```

Connection string format:
```
mongodb+srv://<user>:<password>@sms-cluster.wff27ni.mongodb.net/<db>?retryWrites=true&w=majority
```

DB users and passwords are in `infra/terraform.tfstate` (sensitive — never commit this file).

---

## First-time infrastructure setup

### Prerequisites

```bash
brew install terraform gh
gh auth login
```

### Steps

**1. Install the Vercel GitHub integration**

Before running Terraform, go to https://vercel.com/new and connect your GitHub account. Terraform cannot create the Vercel project without this.

**2. Grant Atlas API key the Project Creator role**

In MongoDB Atlas → Access Manager → API Keys, ensure the key has the **Organization Project Creator** role.

**3. Fill in secrets**

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
# edit infra/terraform.tfvars
```

| Variable | Where to find it |
|----------|-----------------|
| `atlas_org_id` | Atlas → Organizations → Settings |
| `atlas_public_key` / `atlas_private_key` | Atlas → Access Manager → API Keys |
| `render_api_key` | Render → Account Settings → API Keys |
| `render_owner_id` | Render → Account Settings (starts with `usr-` or `tea-`) |
| `vercel_api_token` | Vercel → Settings → Tokens |
| `github_token` | GitHub → Settings → Developer settings → PAT (`repo`, `admin:repo_hook`) |

**4. Apply**

```bash
cd infra
terraform init
terraform apply
```

**5. Seed all databases**

```bash
cd docker/seed && npm install && cd ../..

# get credentials from terraform state, then:
MONGO_URL="..." node docker/seed/seed.js   # run once per environment
```

---

## Upgrading Prod from free tier

If cold-start latency (~30s) becomes a problem, upgrade `sms-prod` in the Render dashboard to the **$7/month Starter** plan — always-on, no sleep. No Terraform change needed.

---

## Tearing down

```bash
cd infra && terraform destroy
```

Deletes all Render services, Vercel project, Atlas cluster, and branch protection rules. MongoDB data is permanently lost. The GitHub repos are not deleted.
