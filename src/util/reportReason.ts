import type { ReportReason } from "@mutualzz/types";

const reportReasonLabels: Record<ReportReason, string> = {
    spam: "Spam",
    harassment: "Harassment or abuse",
    hate_speech: "Hate speech",
    nsfw: "NSFW or inappropriate content",
    self_harm: "Self-harm or suicide",
    impersonation: "Impersonation",
    misinformation: "Misinformation",
    other: "Other policy violation",
};

export function formatStaffReportActionReason(
    report: { reason: ReportReason; description?: string | null },
    staffReason?: string | null,
) {
    if (staffReason?.trim()) return staffReason.trim();

    const label = reportReasonLabels[report.reason] ?? report.reason;
    const description = report.description?.trim();

    if (description) return `${label}: ${description}`;

    return label;
}
