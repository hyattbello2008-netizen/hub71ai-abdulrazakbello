import type {ExtractionResult} from './extractor';

export type SimulatedRouting = {
  mode: 'simulation';
  authority: 'extraction_preview_only';
  status: 'SIMULATED_ROUTING' | 'HUMAN_REVIEW' | 'UNASSIGNED';
  target: 'hub71_simulator' | 'doh_simulator' | 'adek_simulator' | null;
  label: string;
};

// Shared pure switch for the backend response and the explicitly sample-data UI.
// No HTTP request, SQL transition, payment, or trusted completeness is authorized here.
export function simulateGovernmentRouting(payload: ExtractionResult): SimulatedRouting {
  const base = {mode: 'simulation', authority: 'extraction_preview_only'} as const;
  if (!Number.isFinite(payload.evidence_completeness_index) ||
    payload.evidence_completeness_index <= 98 || payload.evidence_completeness_index > 100 ||
    payload.requires_human_review || payload.missing_fields.length > 0) {
    return {...base, status: 'HUMAN_REVIEW', target: null, label: 'Evidence requires human review'};
  }
  switch (payload.persona_class) {
    case 'venture_builder':
      return {...base, status: 'SIMULATED_ROUTING', target: 'hub71_simulator', label: 'Hub71 API (Simulated)'};
    case 'healthcare_specialist':
      return {...base, status: 'SIMULATED_ROUTING', target: 'doh_simulator', label: 'DOH API (Simulated)'};
    case 'educator':
      return {...base, status: 'SIMULATED_ROUTING', target: 'adek_simulator', label: 'ADEK API (Simulated)'};
    case 'corporate_talent':
      return {...base, status: 'UNASSIGNED', target: null, label: 'Corporate talent · institutional review'};
    default:
      return {...base, status: 'HUMAN_REVIEW', target: null, label: 'Persona requires human review'};
  }
}
