export interface Guide { slug: string; title: string; summary: string; steps: string[]; tip?: string }

export const GUIDES: Guide[] = [
  {
    slug: 'create-your-account', title: 'Create your account', summary: 'Set up your business and sign in for the first time.',
    steps: [
      'Select Create a business account on the home page.',
      'Enter your business name, your name, your email and a password of at least 10 characters.',
      'Optionally name your first location, such as your shop or studio. You can add more later.',
      'Check the time zone and currency, then agree to the Terms and Privacy Policy.',
      'Select Create business. You land on your dashboard.',
    ],
    tip: 'The person who creates the business is its owner and can see everything.',
  },
  {
    slug: 'add-customers', title: 'Add customers', summary: 'Keep every customer in one place.',
    steps: [
      'Open Customers from the menu.',
      'Select New customer and fill in their details.',
      'Save. The customer now appears in your list, where you can search for them or edit them later.',
    ],
    tip: 'The Customers area also has tools to import and export customers as a CSV file.',
  },
  {
    slug: 'invite-your-team', title: 'Invite your team', summary: 'Give staff their own sign-in with the right access.',
    steps: [
      'Open Staff & roles from the menu.',
      'Invite a person by email and choose their role.',
      'They receive an email link to join your business.',
      'Use the Roles tab to control what each role can see and do, and the Locations tab to manage your locations.',
    ],
    tip: 'Give each person the smallest role that lets them do their job.',
  },
  {
    slug: 'publish-your-storefront', title: 'Publish your storefront', summary: 'Put your brand online at its own address.',
    steps: [
      'Open Storefront from the menu.',
      'Enter a storefront name, pick a starting template and select Create storefront.',
      'Edit your pages and sections, and add your logo and images.',
      'Preview the site and fix anything that looks wrong.',
      'Publish when you are happy with it.',
    ],
    tip: 'Some templates and features depend on your plan. Locked options show which plan they need.',
  },
  {
    slug: 'change-your-plan', title: 'Change your plan', summary: 'See what your plan includes and upgrade when you need more.',
    steps: [
      'Open Settings from the menu and select Subscription billing.',
      'Compare the plans and pick the one you want.',
      'Choose monthly or annual billing, where annual is offered, and continue to checkout.',
      'Pay on the secure payment page. Your plan updates once the payment is confirmed.',
    ],
    tip: 'The Free plan needs no payment. Limits such as the number of staff, customers and orders depend on your plan.',
  },
];
