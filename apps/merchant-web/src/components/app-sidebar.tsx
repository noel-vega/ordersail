import { useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BookUserIcon,
  CreditCardIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  MapPinIcon,
  SettingsIcon,
  ShelvingUnitIcon,
  ShieldIcon,
  ShoppingBasketIcon,
  ShoppingCartIcon,
  TabletSmartphoneIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { Collapsible, CollapsibleContent } from "ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "ui/sidebar";
import { NavUser } from "./nav-user";
import { navItemVisible, useVisibleNavItems } from "./use-visible-nav-items";

// `permission` hides the item unless the current user holds that key (or any
// key, if an array). undefined = always visible. Keys that don't exist in the
// catalog yet (customers / pos_devices / payments) stay undefined here and get
// their gate in the domain PR that adds the key (OS-178 / OS-179).
export const NAV_ITEMS = [
  {
    key: "home",
    label: "Dashboard",
    icon: LayoutDashboardIcon,
    to: "/app",
    permission: undefined,
    children: undefined,
  },
  {
    key: "orders",
    label: "Orders",
    icon: ShoppingCartIcon,
    to: "/app/orders",
    permission: "orders:read",
    children: undefined,
  },
  {
    key: "failed-orders",
    label: "Failed Orders",
    icon: TriangleAlertIcon,
    to: "/app/failed-orders",
    permission: "orders:read",
    children: undefined,
  },
  {
    key: "carts",
    label: "Carts",
    icon: ShoppingBasketIcon,
    to: "/app/carts",
    permission: "orders:read",
    children: undefined,
  },
  {
    key: "products",
    label: "Products",
    icon: LibraryIcon,
    to: "/app/products",
    permission: "products:read",
    children: [
      {
        label: "Categories",
        to: "/app/products/categories",
        permission: "products:read",
      },
      {
        label: "Brands",
        to: "/app/products/brands",
        permission: "products:read",
      },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: ShelvingUnitIcon,
    to: "/app/inventory",
    permission: "inventory:read",
    children: undefined,
  },
  {
    key: "locations",
    label: "Locations",
    icon: MapPinIcon,
    to: "/app/locations",
    permission: "locations:read",
    children: undefined,
  },
  {
    key: "pos-devices",
    label: "POS Devices",
    icon: TabletSmartphoneIcon,
    to: "/app/pos-devices",
    permission: undefined,
    children: undefined,
  },
  {
    key: "customers",
    label: "Customers",
    icon: BookUserIcon,
    to: "/app/customers",
    permission: undefined,
    children: undefined,
  },
  {
    key: "users",
    label: "Users",
    icon: UsersIcon,
    to: "/app/users",
    permission: "users:read",
    children: undefined,
  },
  {
    key: "roles",
    label: "Roles",
    icon: ShieldIcon,
    to: "/app/roles",
    permission: "roles:read",
    children: undefined,
  },
  {
    key: "developers",
    label: "Developers",
    icon: KeyRoundIcon,
    to: "/app/developers",
    permission: "api_keys:read",
    children: undefined,
  },
  {
    key: "payments",
    label: "Payments",
    icon: CreditCardIcon,
    to: "/app/payments",
    permission: undefined,
    children: undefined,
  },
  {
    key: "settings",
    label: "Settings",
    icon: SettingsIcon,
    to: "/app/settings",
    permission: "account:read",
    children: undefined,
  },
] as const;

export function AppSidebar() {
  // only one collapsible nav item can be open at a time — its own link (or a
  // sub-item link) only ever opens it, any other top-level link closes it
  const [openKey, setOpenKey] = useState<string | null>(null);
  const pathname = useLocation({ select: (location) => location.pathname });
  const { items, perms } = useVisibleNavItems();

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!">
              <span className="text-base font-semibold">Ordersail</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-2">
            <SidebarMenu>
              {items.map((item) => {
                const visibleChildren = item.children?.filter((child) =>
                  navItemVisible(perms, child.permission),
                );
                if (visibleChildren && visibleChildren.length > 0) {
                  const isActive =
                    pathname === item.to || pathname.startsWith(`${item.to}/`);
                  return (
                    <Collapsible
                      key={item.key}
                      open={openKey === item.key}
                      className="group/collapsible"
                    >
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          render={
                            <Link
                              to={item.to}
                              onClick={() => setOpenKey(item.key)}
                            />
                          }
                          tooltip={item.label}
                          isActive={isActive}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {visibleChildren.map((child) => (
                            <SidebarMenuSubItem key={child.to}>
                              <SidebarMenuSubButton
                                render={<Link to={child.to} />}
                                isActive={pathname === child.to}
                              >
                                <span>{child.label}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                }

                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      render={
                        <Link to={item.to} onClick={() => setOpenKey(null)} />
                      }
                      tooltip={item.label}
                      isActive={pathname === item.to}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
