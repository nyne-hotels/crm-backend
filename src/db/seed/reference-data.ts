// Starting pick-lists. The seed only adds rows that are missing, so names
// changed later in Settings are never overwritten.

// The 8 hotels, from the "Our Hotels" menu on nynehotels.com (IDs follow that order).
// Location and type are taken from each hotel's own page.
export const PROPERTIES = [
  { id: 'P01', name: 'Lake Lodge', location: 'Colombo 7', propertyType: 'Boutique hotel', webUrl: 'https://nynehotels.com/lake-lodge/' },
  { id: 'P02', name: 'Rock Villa', location: 'Bentota', propertyType: 'Heritage villa', webUrl: 'https://nynehotels.com/rock-villa/' },
  { id: 'P03', name: 'The Muse', location: 'Bentota', propertyType: 'Boutique hotel', webUrl: 'https://nynehotels.com/the-muse/' },
  { id: 'P04', name: 'Mayur Lodge', location: 'Yala', propertyType: 'Boutique hotel', webUrl: 'https://nynehotels.com/mayur-lodge/' },
  { id: 'P05', name: 'Landesi', location: 'Galle', propertyType: 'Beach villa', webUrl: 'https://nynehotels.com/landesi/' },
  { id: 'P06', name: 'Stafford Bungalow', location: 'Ragala, Nuwara Eliya', propertyType: 'Heritage bungalow', webUrl: 'https://www.staffordbungalow.com/' },
  { id: 'P07', name: 'Anugrah', location: 'Bentota', propertyType: 'Beach hotel', webUrl: 'https://nynehotels.com/anugrah/' },
  { id: 'P08', name: 'Anuprit', location: 'Bentota', propertyType: 'Beach hotel', webUrl: 'https://nynehotels.com/anuprit/' },
  // Not on the website menu, but guests stayed there: Leela has its own PMS export,
  // the other two kept 2018 guest logs (see the master guest list workbook).
  { id: 'P09', name: 'Leela', location: null, propertyType: null, webUrl: null },
  { id: 'P10', name: 'The Long House', location: null, propertyType: null, webUrl: null },
  { id: 'P11', name: 'Taru Villas Yala', location: 'Yala', propertyType: null, webUrl: null },
];

// The 12 trip reasons, in drop-down order.
export const OCCASIONS = [
  'Honeymoon',
  'Wedding anniversary',
  'Birthday',
  'Babymoon',
  'Proposal',
  'Wedding',
  'Family holiday',
  "Friends' getaway",
  'Business trip',
  'Wellness retreat',
  'Other celebration',
  'Leisure',
];

// Labels for grouping guests; admins add more in Settings → Tags.
export const TAGS = ['VIP / industry', 'Friends & family'];
