# VPC with 2 public + 2 private subnets across 2 AZs, and a single NAT gateway
# (cheaper than one per AZ; accepted AZ-level SPOF at this stage) that is torn
# down while the environment is parked — see var.environment_on / OS-380.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = local.azs[count.index]

  tags = { Name = "${var.name_prefix}-private-${local.azs[count.index]}" }
}

# NAT gateway + its EIP exist only while the environment is "on" (OS-380) —
# torn down when parked to save ~$36/mo. Nothing depends on the NAT's public IP
# (no outbound allow-lists), so a new IP on recreate is fine.
resource "aws_eip" "nat" {
  count  = var.environment_on ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat" }
}

# single NAT gateway in the first public subnet — every private subnet's
# route table points here, so a single-AZ outage takes down outbound
# internet access for all private subnets. Accepted tradeoff for cost at
# this stage (one NAT gateway vs. one per AZ).
resource "aws_nat_gateway" "this" {
  count         = var.environment_on ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.name_prefix}-nat" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-public" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-private" }

  # Default route via the NAT, present only while the environment is "on"
  # (OS-380). When parked, this block disappears and Terraform stops managing
  # the route: deleting the NAT leaves it as a harmless blackhole entry (nothing
  # in the private subnets needs egress while parked — RDS is idle, ElastiCache
  # is gone), and the next "on" apply re-points it at the fresh NAT.
  dynamic "route" {
    for_each = var.environment_on ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.this[0].id
    }
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
