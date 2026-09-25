// Router: the guided planner at /agency-planner/, the full planner at /agency-planner/advanced.
import Advanced from './Advanced';
import { Guided } from './guided/Guided';
import { ALL_KEYS } from './state';

const LEGACY = new Set<string>([...ALL_KEYS, 'page', 'goal', 'goalPartner', 'goalMix', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);

export default function App() {
  if (/\/agency-planner\/advanced\/?$/.test(location.pathname)) return <Advanced />;
  // A share link from before the guided planner existed: it carries Advanced's own params.
  if ([...new URLSearchParams(location.search).keys()].some((k) => LEGACY.has(k))) {
    location.replace('/agency-planner/advanced' + location.search);
    return null;
  }
  return <Guided />;
}
