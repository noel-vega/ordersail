# Grafana Cloud as code (OS-758): folders, dashboards and — before launch —
# alert rules and contact points (OS-732). A root of its own, apart from
# envs/production, so a Grafana outage or a bad token never blocks an AWS apply.
#
# Auth: a Grafana service-account token (Editor) in Secrets Manager, read
# ephemerally — the value is used to configure the provider and is never
# written to the plan or the state. All an applier needs is AWS credentials.
# Data sources are not managed here: the CloudWatch one (OS-733) was made by
# hand and would need an Admin token; dashboards pick it through a variable.
#
# Setup and apply: infra/terraform/README.md → "Grafana Cloud as code".

provider "aws" {
  region = var.region
}

ephemeral "aws_secretsmanager_secret_version" "grafana_token" {
  secret_id = var.grafana_token_secret_id
}

provider "grafana" {
  url  = var.grafana_url
  auth = ephemeral.aws_secretsmanager_secret_version.grafana_token.secret_string
}

resource "grafana_folder" "ordersail" {
  uid   = "ordersail"
  title = "Ordersail"
}

# Infra board (OS-91): ECS, ALB, RDS, Redis from the CloudWatch data source
# (OS-733), queried live. The JSON is the source of truth; the dashboard is
# read-only in the UI (editable = false) because edits there would be
# overwritten here. Change dashboards/infra.json and apply.
resource "grafana_dashboard" "infra" {
  folder      = grafana_folder.ordersail.uid
  config_json = file("${path.module}/dashboards/infra.json")
  overwrite   = true
}
