import { type Passkey } from "merchant-sdk";
import { KeyRoundIcon, MoreVerticalIcon } from "lucide-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "ui/item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Button } from "ui/button";

function formatDate(value: string | Date | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function describe(passkey: Passkey): string {
  const lastUsed = formatDate(passkey.lastUsedAt);
  const added = formatDate(passkey.createdAt);
  const parts = [
    lastUsed ? `Last used ${lastUsed}` : "Never used",
    added ? `added ${added}` : null,
    // a multiDevice credential syncs through iCloud Keychain / Google
    // Password Manager, so it survives losing the device — worth saying,
    // because it changes what "I lost my laptop" means for this user
    passkey.backedUp ? "synced to your password manager" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function PasskeyList(props: {
  passkeys: Passkey[];
  onRename: (passkey: Passkey) => void;
  onRemove: (passkey: Passkey) => void;
}) {
  return (
    <ItemGroup>
      {props.passkeys.map((passkey) => (
        <Item key={passkey.id} size="sm" variant="outline">
          <ItemMedia>
            <KeyRoundIcon className="size-4 text-muted-foreground" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{passkey.nickname}</ItemTitle>
            <ItemDescription>{describe(passkey)}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Manage ${passkey.nickname}`}
                  />
                }
              >
                <MoreVerticalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => props.onRename(passkey)}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => props.onRemove(passkey)}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
