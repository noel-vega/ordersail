import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { SidebarMenu, SidebarMenuItem, sidebarMenuButtonVariants } from "ui/sidebar";
import { cn } from "ui/utils";
import { useAuthMe } from "../features/auth/permissions.hooks";
import { useLogoutMutation } from "../features/auth/auth.hooks";

function UserAvatar({ initials }: { initials: string }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground">
      {initials}
    </span>
  );
}

function UserSummary({ name, email }: { name: string; email: string }) {
  return (
    <div className="grid flex-1 text-left text-sm leading-tight">
      <span className="truncate font-medium">{name}</span>
      <span className="truncate text-xs text-muted-foreground">{email}</span>
    </div>
  );
}

export function NavUser() {
  const navigate = useNavigate();
  const logoutMutation = useLogoutMutation();
  const me = useAuthMe();

  const name = me.data
    ? `${me.data.firstName} ${me.data.lastName}`
    : "—";
  const initials = me.data
    ? `${me.data.firstName[0]}${me.data.lastName[0]}`.toUpperCase()
    : "?";
  const email = me.data?.email ?? "";

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => navigate({ to: "/signin" }),
    });
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(sidebarMenuButtonVariants({ size: "lg" }))}
          >
            <UserAvatar initials={initials} />
            <UserSummary name={name} email={email} />
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5">
                  <UserAvatar initials={initials} />
                  <UserSummary name={name} email={email} />
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={handleLogout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
