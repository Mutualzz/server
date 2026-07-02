const NCMEC_BASE =
  process.env.NODE_ENV === "production"
    ? "https://report.cybertip.org/ispws"
    : "https://exttest.cybertip.org/ispws";

const NCMEC_AUTH = Buffer.from(
  `${process.env.NCMEC_USER}:${process.env.NCMEC_PASS}`,
).toString("base64");

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "font/sfnt",
  "application/font-woff2",
  "application/font-woff",
  "application/font-sfnt",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/octet-stream",
]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

const FONT_SIGNATURES: Buffer[] = [
  Buffer.from("wOFF", "ascii"),
  Buffer.from("wOF2", "ascii"),
  Buffer.from("OTTO", "ascii"),
  Buffer.from("true", "ascii"),
  Buffer.from("typ1", "ascii"),
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
];

export const isFontBuffer = (buffer: Buffer): boolean =>
  FONT_SIGNATURES.some((sig) => buffer.subarray(0, sig.length).equals(sig));

export const validateAttachment = (
  mimetype: string,
  size: number,
): { ok: boolean; reason?: string } => {
  if (!ALLOWED_MIME_TYPES.has(mimetype))
    return { ok: false, reason: "File type not allowed" };

  if (size > MAX_FILE_SIZE)
    return { ok: false, reason: "File exceeds 100 MB limit" };

  return { ok: true };
};

// PhotoDNA Hash Scan - TODO: Remember to add this back in when onboarded to PhotoDNA
export const checkPhotoDNA = async (buffer: Buffer): Promise<boolean> => {
  const res = await fetch(
    "https://api.microsoftphotodna.com/image/v1.0/match",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Ocp-Apim-Subscription-Key": process.env.PHOTODNA_KEY!,
      },
      body: Buffer.from(buffer),
    },
  );

  const data = await res.json();
  return data.isMatch === true;
};

// Arachnid Shield hash scan
export const checkArachnid = async (
  buffer: Buffer,
  mimetype: string,
): Promise<boolean> => {
  const credentials = Buffer.from(
    `${process.env.ARACHNID_USER}:${process.env.ARACHNID_PASS}`,
  ).toString("base64");

  const res = await fetch("https://shield.projectarachnid.com/v1/media", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": mimetype,
    },
    body: Buffer.from(buffer),
  });

  const data = await res.json();
  return data.is_match === true;
};

export const reportToNCMEC = async (opts: {
  userId: string;
  username: string;
  email: string;
  ipAddress: string;
  uploadedAt: string;
  buffer: Buffer;
  filename: string;
}): Promise<string> => {
  const headers = {
    Authorization: `Basic ${NCMEC_AUTH}`,
    "Content-Type": "application/xml",
    Accept: "application/xml",
  };

  const submitXml = `<?xml version="1.0" encoding="UTF-8"?>
  <report>
    <incidentType>
      <value>Child Pornography (possession, manufacture, and distribution)</value>
    </incidentType>
    <incidentDateTime>${opts.uploadedAt}</incidentDateTime>
    <reporter>
      <reportingPerson><email>trust-safety@mutualzz.com</email></reportingPerson>
    </reporter>
    <personOrUserReported>
      <espIdentifier>${opts.userId}</espIdentifier>
      <screenName>${opts.username}</screenName>
      <email>${opts.email}</email>
      <ipCaptureEvent>
        <ipAddress>${opts.ipAddress}</ipAddress>
        <eventName>file_upload</eventName>
        <dateTime>${opts.uploadedAt}</dateTime>
      </ipCaptureEvent>
    </personOrUserReported>
  </report>`;

  const submitRes = await fetch(`${NCMEC_BASE}/submit`, {
    method: "POST",
    headers,
    body: submitXml,
  });
  const submitText = await submitRes.text();
  const reportIdMatch = submitText.match(/<reportId>(\d+)<\/reportId>/);
  if (!reportIdMatch) throw new Error(`NCMEC submit failed: ${submitText}`);
  const reportId = reportIdMatch[1];

  const form = new FormData();
  form.append("id", reportId);
  form.append("file", new Blob([Buffer.from(opts.buffer)]), opts.filename);
  await fetch(`${NCMEC_BASE}/upload`, {
    method: "POST",
    headers: { Authorization: `Basic ${NCMEC_AUTH}` },
    body: form,
  });

  const fileinfoXml = `<?xml version="1.0" encoding="UTF-8"?>
<fileInfo>
  <reportId>${reportId}</reportId>
  <fileId>file-1</fileId>
  <fileViewedByEsp>false</fileViewedByEsp>
  <fileUploadedDateTime>${opts.uploadedAt}</fileUploadedDateTime>
  <publiclyAvailable>false</publiclyAvailable>
</fileInfo>`;
  await fetch(`${NCMEC_BASE}/fileinfo`, {
    method: "POST",
    headers,
    body: fileinfoXml,
  });

  const finishXml = `<?xml version="1.0" encoding="UTF-8"?>
  <finish><reportId>${reportId}</reportId></finish>`;
  const finishRes = await fetch(`${NCMEC_BASE}/finish`, {
    method: "POST",
    headers,
    body: finishXml,
  });
  const finishText = await finishRes.text();
  if (!finishText.includes("<responseCode>success</responseCode>"))
    throw new Error(`NCMEC finish failed: ${finishText}`);

  return reportId;
};
