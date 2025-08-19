import { S3Client } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
    region: "auto",
    credentials: {
        accountId: process.env.AWS_ACCOUNT_ID,
        accessKeyId: process.env.AWS_ACCESS_KEY!,
        secretAccessKey: process.env.AWS_ACCESS_SECRET!,
    },
    endpoint: process.env.AWS_ENDPOINT,
});

const bucketName = process.env.AWS_BUCKET!;

export { bucketName, s3Client };
