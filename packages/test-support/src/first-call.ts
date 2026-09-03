// jest records call args as `any[]`; hand back the first call's args as
// `unknown[]` (cast to a tuple at the call site) so assertions on them stay
// under the `no-unsafe-*` lint rules.
export function firstCall(mock: jest.Mock): unknown[] {
  return (mock.mock.calls[0] ?? []) as unknown[];
}
