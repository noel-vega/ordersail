# Fill these in before running `terraform apply`.

region      = "us-east-1"
name_prefix = "ordersail"

github_repo = "noel-vega/ordersail"
# immutable OIDC subject prefix halves — `gh api repos/noel-vega/ordersail --jq '.owner.id, .id'`
# (changes only on a GitHub owner/repo transfer)
github_owner_id = 179352624
github_repo_id  = 1292329338

domain_name = "ordersail.com"

# real address you control — SES sends a confirmation email here that must
# be clicked manually before sending will work (see Phase 9)
ses_verified_email = "noelvegajr94@gmail.com"

# Google Workspace (OS-665) — public DNS values from the Workspace admin console.
google_site_verification = "google-site-verification=o8MTNIKX8nvDf_6g1duGU_RHvmCeM5XGzo9asfMkerA"
# google_dkim_txt = "v=DKIM1; k=rsa; p=…"   # set once Google offers DKIM (after domain verification)
