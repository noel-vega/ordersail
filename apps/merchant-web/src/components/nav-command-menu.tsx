import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "ui/command";
import { navItemVisible, useVisibleNavItems } from "./use-visible-nav-items";

export function NavCommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { items, perms } = useVisibleNavItems();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(to: string) {
    navigate({ to });
    setOpen(false);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Navigate"
      description="Jump to a page..."
    >
      <CommandInput placeholder="Search pages..." />
      <CommandList>
        <CommandEmpty>No matching page.</CommandEmpty>
        <CommandGroup heading="Pages">
          {items.map((item) => (
            <CommandItem key={item.to} onSelect={() => go(item.to)}>
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
          {items.flatMap((item) =>
            item.children
              ? item.children
                  .filter((child) => navItemVisible(perms, child.permission))
                  .map((child) => (
                    <CommandItem key={child.to} onSelect={() => go(child.to)}>
                      <span className="text-muted-foreground">
                        {item.label} /
                      </span>
                      {child.label}
                    </CommandItem>
                  ))
              : [],
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
