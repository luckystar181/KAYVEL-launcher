export type PreparationStage = 'java' | 'minecraft' | 'neoforge' | 'modpack' | 'verify' | 'ready' | 'launch' | 'error';
export type PreparationProgress = {
  stage: PreparationStage;
  file: string;
  received: number;
  total: number | null;
  completedFiles: number;
  totalFiles: number | null;
};
export type ReportProgress = (progress: PreparationProgress) => void;

export function stageProgress(report: ReportProgress, stage: PreparationStage, file = ''): void {
  report({ stage, file, received: 0, total: null, completedFiles: 0, totalFiles: null });
}
