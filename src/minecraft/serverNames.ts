export const customServerName = (
  serverId: string,
  displayName?: string | null,
) => {
  const name = displayName?.trim() ?? "";
  return name && name.toLowerCase() !== serverId.toLowerCase() ? name : null;
};
