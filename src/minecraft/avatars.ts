export const minecraftAvatarUrl = (uuid: string): string => {
  const id = uuid.trim().toLowerCase();
  return `https://mc-heads.net/head/${id}/left`;
};
