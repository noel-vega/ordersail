import { useState } from "react"
import { PlusIcon } from "lucide-react"
import type { ApiKey } from "merchant-sdk"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card"
import { Button } from "ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "ui/input-group"
import { CopyButton } from "../../../components/copy-button"
import { useListApiKeysQuery } from "../api-keys.hooks"
import { CreateApiKeyDialog } from "../components/create-api-key-dialog"
import { RevokeApiKeyDialog } from "../components/revoke-api-key-dialog"

export function ApiKeysView() {
  const apiKeys = useListApiKeysQuery()
  const keys = apiKeys.data ?? []
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Storefront API keys</CardTitle>
              <CardDescription>
                Use a key to identify your shop when calling the storefront
                API — e.g. initializing the storefront SDK on your site. It&apos;s
                safe to include in client-side code.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon /> Create key
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {apiKeys.isLoading && (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}

          {!apiKeys.isLoading && keys.length === 0 && (
            <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              No API keys yet — create one to connect your storefront.
            </p>
          )}

          {keys.map((apiKey) => (
            <div key={apiKey.id} className="space-y-1">
              {apiKey.label && (
                <p className="text-sm font-medium">{apiKey.label}</p>
              )}
              <div className="flex items-center gap-2">
                <InputGroup>
                  <InputGroupInput readOnly value={apiKey.key} />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={apiKey.key} label="Copy key" />
                  </InputGroupAddon>
                </InputGroup>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevoking(apiKey)}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <CreateApiKeyDialog open={creating} onOpenChange={setCreating} />
      <RevokeApiKeyDialog
        apiKey={revoking}
        isLastKey={keys.length === 1}
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
      />
    </div>
  )
}
