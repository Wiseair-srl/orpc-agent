import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createCapabilityClient, type CapabilityClient, type CapabilityRPCClient } from "./client/index";
export type HttpCapabilityClientOptions = ConstructorParameters<typeof RPCLink>[0];
/** Native oRPC HTTP codec; supply fresh auth via headers/fetch, and the gateway mount URL. */
export function createHttpCapabilityClient(options: HttpCapabilityClientOptions): CapabilityClient {
  return createCapabilityClient({ rpc: createORPCClient<CapabilityRPCClient>(new RPCLink(options)) });
}
