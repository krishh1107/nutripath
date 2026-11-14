// Reference data for NutriPath — single source of truth (served from memory;
// user data lives in SQLite — see db.js / schema.sql). Covers
// foods, recipes, supplements and supplement_warnings.
// Nutrient values are approximate, per 100 g (IFCT 2017 / USDA reference values).

const FOODS = [
  // name, category, origin, kcal, protein, carbs, fat, fiber, iron, calcium, vitC, b12, vitD(IU), omega3, gi, cost ₹/kg, tags
  ['Quinoa', 'grain', 'imported', 368, 14.1, 64.2, 6.1, 7.0, 4.6, 47, 0, 0, 0, 0.3, 53, 600, ['protein', 'fiber']],
  ['Soy Chunks', 'legume', 'local', 345, 52.0, 33.0, 0.5, 13.0, 10.0, 350, 0, 0, 0, 0.6, 15, 200, ['protein', 'iron']],
  ['Foxtail Millet', 'grain', 'local', 331, 12.3, 60.1, 4.3, 8.0, 2.8, 31, 0, 0, 0, 0.1, 50, 120, ['fiber', 'low_gi']],
  ['Ragi (Finger Millet)', 'grain', 'local', 328, 7.3, 72.0, 1.3, 11.5, 3.9, 344, 0, 0, 0, 0.0, 60, 80, ['calcium', 'fiber']],
  ['Bajra (Pearl Millet)', 'grain', 'local', 361, 11.6, 67.5, 5.0, 11.5, 6.4, 42, 0, 0, 0, 0.1, 55, 60, ['iron', 'fiber']],
  ['Whey Protein', 'supplement', 'imported', 400, 78.0, 8.0, 6.0, 0, 1.0, 500, 0, 0.6, 0, 0, 0, 3000, ['protein']],
  ['Sattu (Roasted Chana Flour)', 'legume', 'local', 406, 20.6, 58.0, 5.6, 18.0, 5.0, 60, 0, 0, 0, 0.1, 28, 120, ['protein', 'fiber', 'iron']],
  ['Paneer', 'dairy', 'local', 265, 18.3, 1.2, 20.8, 0, 0.2, 480, 0, 0.8, 10, 0.1, 0, 400, ['protein', 'calcium', 'b12']],
  ['Blueberries', 'fruit', 'imported', 57, 0.7, 14.5, 0.3, 2.4, 0.3, 6, 9.7, 0, 0, 0.1, 53, 2000, ['vitamin_c', 'antioxidant']],
  ['Amla (Indian Gooseberry)', 'fruit', 'local', 44, 0.9, 10.2, 0.6, 4.3, 0.3, 25, 600, 0, 0, 0, 15, 80, ['vitamin_c', 'antioxidant']],
  ['Guava', 'fruit', 'local', 68, 2.6, 14.3, 1.0, 5.4, 0.3, 18, 228, 0, 0, 0, 25, 80, ['vitamin_c', 'fiber']],
  ['Palak (Spinach)', 'vegetable', 'local', 23, 2.9, 3.6, 0.4, 2.2, 2.7, 99, 28, 0, 0, 0.1, 15, 60, ['iron', 'oxalate_high']],
  ['Rajma (Kidney Beans)', 'legume', 'local', 333, 22.5, 60.0, 0.8, 15.2, 5.1, 143, 4.5, 0, 0, 0.2, 29, 160, ['protein', 'iron', 'soluble_fiber']],
  ['Flaxseed', 'seed', 'local', 534, 18.3, 28.9, 42.2, 27.3, 5.7, 255, 0.6, 0, 0, 22.8, 35, 250, ['omega3', 'soluble_fiber']],
  ['Walnuts', 'nut', 'imported', 654, 15.2, 13.7, 65.2, 6.7, 2.9, 98, 1.3, 0, 0, 9.1, 15, 900, ['omega3']],
  ['Curd (Dahi)', 'dairy', 'local', 61, 3.5, 4.7, 3.3, 0, 0.1, 121, 0.5, 0.4, 2, 0, 35, 70, ['b12', 'calcium', 'probiotic']],
  ['Toned Milk (Vit-D fortified)', 'dairy', 'local', 58, 3.1, 4.8, 3.0, 0, 0.1, 120, 1, 0.4, 40, 0, 32, 56, ['b12', 'calcium', 'vitamin_d']],
  ['Eggs', 'animal', 'local', 143, 12.6, 0.7, 9.5, 0, 1.8, 56, 0, 1.1, 82, 0.1, 0, 160, ['protein', 'b12', 'vitamin_d']],
  ['Oats', 'grain', 'local', 389, 13.2, 66.3, 6.9, 10.6, 4.7, 54, 0, 0, 0, 0.1, 55, 180, ['soluble_fiber', 'low_gi']],
  ['Isabgol (Psyllium Husk)', 'fiber', 'local', 375, 1.5, 85.0, 0.6, 80.0, 0.9, 130, 0, 0, 0, 0, 0, 600, ['soluble_fiber']],
  ['White Rice', 'grain', 'local', 345, 6.8, 78.2, 0.5, 0.2, 0.7, 10, 0, 0, 0, 0, 73, 50, ['high_gi']],
  ['Peanuts', 'nut', 'local', 567, 25.8, 16.1, 49.2, 8.5, 4.6, 92, 0, 0, 0, 0, 14, 160, ['protein', 'omega6_high']],
  ['Methi Seeds', 'seed', 'local', 323, 23.0, 58.4, 6.4, 24.6, 33.5, 176, 3, 0, 0, 0.0, 25, 200, ['soluble_fiber', 'iron', 'low_gi']],
  ['Til (Sesame Seeds)', 'seed', 'local', 573, 17.7, 23.5, 49.7, 11.8, 14.6, 975, 0, 0, 0, 0.4, 35, 240, ['calcium', 'iron']],
].map(([name, category, origin, kcal, protein_g, carbs_g, fat_g, fiber_g, iron_mg, calcium_mg, vitamin_c_mg, b12_mcg, vitamin_d_iu, omega3_g, gi, cost_inr_per_kg, tags], i) => ({
  id: i + 1, name, category, origin, kcal, protein_g, carbs_g, fat_g, fiber_g, iron_mg, calcium_mg,
  vitamin_c_mg, b12_mcg, vitamin_d_iu, omega3_g, gi, cost_inr_per_kg, tags,
}));

// appliance: none | kettle | induction (what the recipe needs at minimum)
const RECIPES = [
  { name: 'Sattu Power Drink', appliance: 'none', prep_min: 3, kcal: 165, protein_g: 8, cost_inr: 8,
    ingredients: ['40 g sattu', '1 glass water', 'Lemon', 'Roasted jeera', 'Black salt'],
    steps: 'Whisk sattu into water, add lemon, jeera and black salt. Drink within 10 minutes.', tags: ['protein', 'no_cook'] },
  { name: 'Overnight Oats with Curd & Chia', appliance: 'none', prep_min: 5, kcal: 330, protein_g: 14, cost_inr: 25,
    ingredients: ['50 g oats', '150 g curd', '1 tbsp chia/flax', '1 banana'],
    steps: 'Mix oats, curd and seeds in a jar; refrigerate (or keep cool) overnight. Top with banana.', tags: ['b12', 'omega3', 'no_cook'] },
  { name: 'Moong Sprouts Chaat + Lemon', appliance: 'none', prep_min: 5, kcal: 180, protein_g: 12, cost_inr: 15,
    ingredients: ['1 katori moong sprouts', 'Onion & tomato', 'Lemon', 'Chaat masala'],
    steps: 'Toss sprouts with chopped veg; squeeze lemon generously (Vitamin C doubles iron uptake).', tags: ['iron', 'no_cook'] },
  { name: 'Kettle-Boiled Eggs (3)', appliance: 'kettle', prep_min: 12, kcal: 215, protein_g: 19, cost_inr: 21,
    ingredients: ['3 eggs', 'Salt & pepper'],
    steps: 'Place eggs in kettle, cover with water, boil, then let sit 10 minutes with lid closed.', tags: ['protein', 'b12', 'vitamin_d'] },
  { name: 'Kettle Soya Chunk Bhel', appliance: 'kettle', prep_min: 15, kcal: 195, protein_g: 26, cost_inr: 12,
    ingredients: ['50 g soya chunks', 'Onion, tomato, cucumber', 'Lemon', 'Chaat masala', 'Roasted peanuts'],
    steps: 'Soak chunks in kettle-hot water 10 min, squeeze dry, toss with veg, lemon and masala.', tags: ['protein', 'iron'] },
  { name: 'Kettle Masala Oats', appliance: 'kettle', prep_min: 8, kcal: 260, protein_g: 10, cost_inr: 18,
    ingredients: ['50 g oats', 'Hot water from kettle', 'Peanuts', 'Chopped veg', 'Masala'],
    steps: 'Pour boiling water over oats and veg in a steel tiffin, cover 5 min, stir in peanuts.', tags: ['soluble_fiber'] },
  { name: 'Instant Poha Cup + Roasted Chana', appliance: 'kettle', prep_min: 6, kcal: 300, protein_g: 11, cost_inr: 20,
    ingredients: ['Instant poha cup', '30 g roasted chana', 'Lemon'],
    steps: 'Add kettle water to poha cup, rest 3 min, top with chana and lemon.', tags: ['iron'] },
  { name: 'Paneer Bhurji', appliance: 'induction', prep_min: 15, kcal: 330, protein_g: 20, cost_inr: 45,
    ingredients: ['100 g paneer', 'Onion & tomato', '1 tsp oil', 'Haldi, jeera'],
    steps: 'Saute onion-tomato, crumble in paneer, cook 3 min with spices.', tags: ['protein', 'calcium', 'b12'] },
  { name: 'Moong Dal Chilla (2)', appliance: 'induction', prep_min: 20, kcal: 280, protein_g: 16, cost_inr: 15,
    ingredients: ['60 g soaked moong dal', 'Ginger, chilli', 'Coriander'],
    steps: 'Grind soaked dal to a batter, spread thin on a hot tawa, cook both sides.', tags: ['protein', 'iron'] },
].map((r, i) => ({ id: i + 1, ...r }));

const SUPPLEMENTS = [
  { name: 'Whey Protein', category: 'Protein', typical_dose: '20–30 g/day', evidence_level: 'strong',
    benefits: 'Convenient complete protein for muscle recovery.',
    local_alternative: 'Sattu (roasted chana flour) — ~20 g protein per 100 g, ~₹120/kg' },
  { name: 'Creatine Monohydrate', category: 'Performance', typical_dose: '3–5 g/day', evidence_level: 'strong',
    benefits: 'Improves strength, power output and lean mass.',
    local_alternative: 'No direct veg equivalent; small amounts in fish/meat.' },
  { name: 'Vitamin B12', category: 'Vitamin', typical_dose: '500–1000 mcg/day (or as prescribed)', evidence_level: 'strong',
    benefits: 'Essential for nerves and red blood cells; commonly deficient in vegetarians.',
    local_alternative: 'Curd, milk, paneer, eggs' },
  { name: 'Vitamin D3', category: 'Vitamin', typical_dose: '1000–2000 IU/day', evidence_level: 'strong',
    benefits: 'Bone health and immunity; deficiency is widespread in India.',
    local_alternative: '15–20 min of midday sunlight on arms; fortified milk; eggs' },
  { name: 'Iron (Ferrous Sulfate)', category: 'Mineral', typical_dose: 'As prescribed after blood test', evidence_level: 'strong',
    benefits: 'Treats iron-deficiency anaemia.',
    local_alternative: 'Bajra, rajma, soy chunks, til + lemon (Vitamin C)' },
  { name: 'Omega-3 (Fish Oil)', category: 'Fatty Acid', typical_dose: '250–500 mg EPA+DHA/day', evidence_level: 'moderate',
    benefits: 'Heart and brain health; anti-inflammatory.',
    local_alternative: 'Flaxseed, walnuts, chia (ALA); algal oil for vegans' },
].map((s, i) => ({ id: i + 1, ...s }));

const SUPPLEMENT_WARNINGS = [
  ['Whey Protein', 'levodopa', 'moderate', 'Protein can reduce levodopa absorption; space doses.'],
  ['Whey Protein', 'alendronate', 'low', 'Take bisphosphonates on an empty stomach, 30 min before.'],
  ['Creatine Monohydrate', 'nsaids', 'moderate', 'Combined kidney load; avoid with regular NSAID use.'],
  ['Creatine Monohydrate', 'diuretics', 'high', 'Risk of dehydration and kidney strain.'],
  ['Creatine Monohydrate', 'metformin', 'low', 'Monitor kidney function.'],
  ['Vitamin B12', 'metformin', 'moderate', 'Metformin lowers B12 levels — supplementation often recommended.'],
  ['Vitamin B12', 'omeprazole', 'moderate', 'PPIs reduce B12 absorption.'],
  ['Vitamin D3', 'thiazide', 'moderate', 'Risk of high blood calcium.'],
  ['Vitamin D3', 'digoxin', 'high', 'Hypercalcemia can trigger digoxin toxicity.'],
  ['Iron (Ferrous Sulfate)', 'levothyroxine', 'high', 'Iron blocks thyroid hormone absorption; separate by 4 hrs.'],
  ['Iron (Ferrous Sulfate)', 'omeprazole', 'moderate', 'Reduced stomach acid lowers iron absorption.'],
  ['Iron (Ferrous Sulfate)', 'ciprofloxacin', 'high', 'Iron binds the antibiotic; separate by 2–6 hrs.'],
  ['Omega-3 (Fish Oil)', 'warfarin', 'high', 'Increased bleeding risk.'],
  ['Omega-3 (Fish Oil)', 'aspirin', 'moderate', 'Additive anti-platelet effect.'],
].map(([supplement_name, medication, severity, note], i) => ({ id: i + 1, supplement_name, medication, severity, note }));

// Demo lab results for Rohan (illustrative, not real patient data)
const HEALTH_OBSERVATIONS = [
  ['Hemoglobin', 12.4, 'g/dL', '13.0–17.0', 'low'],
  ['Serum Ferritin', 18, 'ng/mL', '30–300', 'low'],
  ['Vitamin B12', 165, 'pg/mL', '200–900', 'low'],
  ['Vitamin D (25-OH)', 16, 'ng/mL', '30–100', 'deficient'],
  ['Fasting Glucose', 88, 'mg/dL', '70–99', 'normal'],
  ['Total Cholesterol', 172, 'mg/dL', '< 200', 'normal'],
  ['Blood Pressure (systolic)', 118, 'mmHg', '< 120', 'normal'],
].map(([metric, value, unit, reference_range, status], i) => ({
  id: i + 1, user_id: 1, observed_on: '2026-10-28', metric, value, unit, reference_range, status,
}));

module.exports = { FOODS, RECIPES, SUPPLEMENTS, SUPPLEMENT_WARNINGS, HEALTH_OBSERVATIONS };
