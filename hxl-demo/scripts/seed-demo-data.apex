/**
 * Seed a few HXL orders for a demo contact, so the signed-in view is not empty
 * on stage.
 *
 *   sf apex run --file scripts/seed-demo-data.apex
 *
 * Set DEMO_EMAIL to the email of the community user you will log in as. If no
 * Contact matches, this creates one - but note that a Contact alone is not a
 * login; the user still has to exist (register through the app, or enable a
 * customer user on the Contact in Setup).
 */

final String DEMO_EMAIL = 'ada@example.com';

List<Contact> matches = [SELECT Id, Name FROM Contact WHERE Email = :DEMO_EMAIL LIMIT 1];

Contact demo;
if (matches.isEmpty()) {
    Account acct;
    List<Account> accts = [SELECT Id FROM Account WHERE Name = 'HXL Demo Customers' LIMIT 1];
    if (accts.isEmpty()) {
        acct = new Account(Name = 'HXL Demo Customers');
        insert acct;
    } else {
        acct = accts[0];
    }
    demo = new Contact(FirstName = 'Ada', LastName = 'Lovelace', Email = DEMO_EMAIL, AccountId = acct.Id);
    insert demo;
    System.debug('Created Contact ' + demo.Id + ' for ' + DEMO_EMAIL);
} else {
    demo = matches[0];
    System.debug('Using existing Contact ' + demo.Id);
}

delete [SELECT Id FROM HXL_Order__c WHERE Owner_Contact__c = :demo.Id];

insert new List<HXL_Order__c>{
    new HXL_Order__c(Owner_Contact__c = demo.Id, Status__c = 'Shipped',
                     Total_Amount__c = 129.00, Placed_On__c = System.now().addDays(-21)),
    new HXL_Order__c(Owner_Contact__c = demo.Id, Status__c = 'Shipped',
                     Total_Amount__c = 64.50,  Placed_On__c = System.now().addDays(-9)),
    new HXL_Order__c(Owner_Contact__c = demo.Id, Status__c = 'Submitted',
                     Total_Amount__c = 249.99, Placed_On__c = System.now().addDays(-2))
};

// A second contact's order, so "scoped to the token" is provable rather than
// merely asserted. This one must never show up in the app.
List<Contact> others = [SELECT Id FROM Contact WHERE Email = 'somebody.else@example.com' LIMIT 1];
Contact other;
if (others.isEmpty()) {
    other = new Contact(FirstName = 'Grace', LastName = 'Hopper', Email = 'somebody.else@example.com');
    insert other;
} else {
    other = others[0];
}
delete [SELECT Id FROM HXL_Order__c WHERE Owner_Contact__c = :other.Id];
insert new HXL_Order__c(Owner_Contact__c = other.Id, Status__c = 'Shipped',
                        Total_Amount__c = 9999.00, Placed_On__c = System.now());

System.debug('Seeded. The 9999.00 order belongs to another contact and must NOT appear in the app.');
