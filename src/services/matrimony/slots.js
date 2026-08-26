/**
 * Make My Lagan (MML) matrimony intake steps.
 * One question at a time → collect → thank you → end call.
 */
export const MATRIMONY_STEPS = Object.freeze([
  {
    id: 'name',
    field: 'name',
    question:
      'सबसे पहले बताइए, आपका पूरा नाम क्या है?',
  },
  {
    id: 'gender',
    field: 'gender',
    question:
      'धन्यवाद। कृपया बताइए, आप पुरुष हैं या महिला?',
  },
  {
    id: 'date_of_birth',
    field: 'dateOfBirth',
    question:
      'ठीक है। आपकी जन्म तिथि क्या है? दिन, महीना और साल बताइए।',
  },
  {
    id: 'partner_details',
    field: 'partnerDetails',
    question:
      'अब बताइए आप अपने जीवनसाथी में क्या चाहेंगे — जैसे उम्र, शहर, शिक्षा, धर्म या कोई अन्य खास बात।',
  },
]);

export const MML_GREETING =
  'नमस्ते! मैं Make My Lagan, यानी MML की ओर से बात कर रही हूँ। हम आपकी शादी संबंधी ज़रूरतें समझना चाहते हैं। कुछ छोटे सवाल पूछूँगी, कृपया एक-एक करके जवाब दीजिए।';

export const MML_THANKS =
  'आपका बहुत-बहुत धन्यवाद। आपकी जानकारी Make My Lagan के पास सुरक्षित दर्ज कर ली गई है। हमारी टीम जल्द आपसे संपर्क करेगी। शुभकामनाएँ! कॉल यहीं समाप्त होती है।';

export function createEmptyIntake() {
  return {
    name: null,
    gender: null,
    dateOfBirth: null,
    partnerDetails: null,
    completed: false,
    completedAt: null,
  };
}
