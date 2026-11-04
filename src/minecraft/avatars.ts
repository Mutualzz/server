export const minecraftAvatarUrl = (uuid: string): string => {
  const id = uuid.trim().toLowerCase().replace(/-/g, "");
  return `https://minotar.net/cube/${id}/128.png`;
};
