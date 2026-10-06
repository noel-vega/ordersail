locals {
  repo_names = ["merchant-api", "storefront-api", "worker", "migrator", "pos-api"]
}

resource "aws_ecr_repository" "this" {
  for_each = toset(local.repo_names)

  name = "${var.name_prefix}-${each.value}"
  # Every tag is a git SHA, written once: cd.yml either builds the image for
  # that SHA or, when the commit can't change it, adds the SHA as one more tag
  # on the previous image (OS-746) — so one image can carry many tags. It never
  # rewrites a SHA already in the repo. IMMUTABLE makes that a guarantee: a
  # tag, once pushed, always resolves to the same image.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        # counts images (digests), not tags: an image re-tagged by every
        # deploy that left it unchanged is still one image
        rulePriority = 1
        description  = "keep last 15 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 15
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      }
    ]
  })
}
