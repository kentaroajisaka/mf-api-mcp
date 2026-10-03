import { z } from "zod";

export function cloudBoxFileUrls(fileId: string) {
  const id = z.string().uuid().parse(fileId);
  return { file_id: id,
    detail_url: `https://box.moneyforward.com/files/${id}`,
    web_download_url: `https://box.moneyforward.com/frontend/v3/files/${id}/download`,
    api_download_url: `https://api.box.moneyforward.com/v1/files/${id}/download`,
    web_auth: "authenticated_CloudBox_browser_session", api_auth: "CloudBox_OAuth_Bearer",
    note: "URL construction does not verify access. Web and API access differ; signed redirect URLs are not generated or stored." };
}
export function memoEvidenceUrls(memo?: string | null) {
  const ids = [...(memo ?? "").matchAll(/https:\/\/box\.moneyforward\.com\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z-])/gi)].map((m) => m[1]);
  return [...new Set(ids)].map(cloudBoxFileUrls);
}
