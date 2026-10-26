import { parentPort, workerData } from "node:worker_threads";
import { collectReportContent, type FeedbackContentJob } from "./feedback-reporting-content";
if (parentPort && workerData?.kind === "dingtalk-feedback-detail") {
  collectReportContent(workerData.job as FeedbackContentJob).then(
    (content) => parentPort!.postMessage(content),
    () => parentPort!.postMessage({ mode: "replace", status: "pending", reason: "read_failed" }),
  );
}
