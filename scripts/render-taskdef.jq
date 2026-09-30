# Turns the Terraform-owned task-def contract (SSM /ordersail/production/ecs/<app>-taskdef)
# into a registerable revision: pins the image and stamps SENTRY_RELEASE with the same
# git SHA, so Sentry tags every event with the code that threw it (OS-67). Shared by
# cd.yml (deploy) and environment.yml (resume) so the two can't drift.
#
#   jq --arg IMAGE "<uri>:<sha>" --arg RELEASE "<sha>" -f scripts/render-taskdef.jq
#
# SENTRY_RELEASE is upserted: the contract never carries it (it changes every deploy),
# but a rewrite must not duplicate it either.
.containerDefinitions[0].image = $IMAGE
| .containerDefinitions[0].environment = (
    [(.containerDefinitions[0].environment // [])[] | select(.name != "SENTRY_RELEASE")]
    + [{ name: "SENTRY_RELEASE", value: $RELEASE }]
  )
