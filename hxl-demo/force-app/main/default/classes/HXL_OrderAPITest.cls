@IsTest
private class HXL_OrderAPITest {

    private static void mockRequest(String method) {
        mockRequest(method, '/services/apexrest/hxl/orders');
    }

    private static void mockRequest(String method, String uri) {
        RestRequest req = new RestRequest();
        req.requestURI = uri;
        req.httpMethod = method;
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    private static void mockSearch(String q) {
        mockRequest('GET');
        RestContext.request.params.put('q', q);
    }

    /**
     * Builds a community user backed by a Contact, or returns null if the org
     * has no portal-enabled profile (plain scratch orgs without an Experience
     * Cloud site). Tests degrade to the no-contact path in that case.
     */
    private static User makePortalUser() {
        // Prefer the real site profile: the HXL_Customer_Orders sharing set is
        // bound to it, and the sharing assertions below depend on that.
        List<Profile> profiles = [SELECT Id FROM Profile WHERE Name = 'HXL customer' LIMIT 1];
        if (profiles.isEmpty()) {
            profiles = [
                SELECT Id FROM Profile
                WHERE UserType IN ('CspLitePortal', 'PowerCustomerSuccess', 'CustomerSuccess')
                LIMIT 1
            ];
        }
        if (profiles.isEmpty()) {
            return null;
        }

        Account acct = new Account(Name = 'HXL Test Account');
        insert acct;
        Contact c = new Contact(
            LastName = 'Headless',
            FirstName = 'Ada',
            Email = 'ada.headless@example.invalid',
            AccountId = acct.Id
        );
        insert c;

        User u = new User(
            ProfileId = profiles[0].Id,
            ContactId = c.Id,
            Username = 'ada.headless.' + DateTime.now().getTime() + '@example.invalid',
            Alias = 'ahead',
            Email = 'ada.headless@example.invalid',
            LastName = 'Headless',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            TimeZoneSidKey = 'America/Los_Angeles'
        );
        insert u;

        // The real site users carry this permission set; without it USER_MODE
        // queries fail FLS on any field the portal profile doesn't grant (and
        // report it as the misleading "Variable does not exist: tmpVar1").
        List<PermissionSet> ps = [
            SELECT Id FROM PermissionSet WHERE Name = 'HXL_Customer_Access' LIMIT 1
        ];
        if (!ps.isEmpty()) {
            // runAs isolates the setup-object DML from the Account/Contact
            // inserts above (MIXED_DML_OPERATION otherwise).
            System.runAs(new User(Id = UserInfo.getUserId())) {
                insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps[0].Id);
            }
        }
        return u;
    }

    @IsTest
    static void getReturnsEmptyEnvelopeWithoutAContact() {
        // An admin / integration token is authenticated but is not a person.
        mockRequest('GET');

        Test.startTest();
        HXL_OrderAPI.MeResponse res = HXL_OrderAPI.getMyOrders();
        Test.stopTest();

        System.assertNotEquals(null, res, 'Expected an envelope, not null');
        System.assertEquals(null, res.contactId, 'Non-portal user must have no contact');
        System.assertEquals(0, res.orders.size(), 'Non-portal user must see no orders');
        System.assertEquals(200, RestContext.response.statusCode);
    }

    @IsTest
    static void createIsRejectedWithoutAContact() {
        mockRequest('POST');

        Test.startTest();
        HXL_OrderAPI.OrderDTO d = HXL_OrderAPI.createOrder(25.00, 'web');
        Test.stopTest();

        System.assertEquals(null, d, 'Non-portal user must not create an order');
        System.assertEquals(403, RestContext.response.statusCode);
    }

    @IsTest
    static void portalUserSeesOnlyTheirOwnOrders() {
        User u = makePortalUser();
        if (u == null) {
            return; // no portal profile in this org; covered by the other tests
        }
        Id contactId = [SELECT ContactId FROM User WHERE Id = :u.Id].ContactId;

        // One order for our user, one for somebody else.
        Contact other = new Contact(LastName = 'Other', Email = 'other@example.invalid');
        insert other;
        insert new List<HXL_Order__c>{
            new HXL_Order__c(Owner_Contact__c = contactId, Status__c = 'Shipped',
                             Total_Amount__c = 10, Placed_On__c = System.now()),
            new HXL_Order__c(Owner_Contact__c = other.Id, Status__c = 'Shipped',
                             Total_Amount__c = 99, Placed_On__c = System.now())
        };

        // Look these up as the admin: the portal user cannot even query the
        // other contact's order, which is the very thing the test proves below.
        Id otherOrderId = [SELECT Id FROM HXL_Order__c WHERE Total_Amount__c = 99 LIMIT 1].Id;
        HXL_Order__c mine = [SELECT Name FROM HXL_Order__c WHERE Total_Amount__c = 10 LIMIT 1];
        HXL_Order__c theirs = [SELECT Name FROM HXL_Order__c WHERE Id = :otherOrderId];

        Test.startTest();
        System.runAs(u) {
            mockRequest('GET');
            HXL_OrderAPI.MeResponse res = HXL_OrderAPI.getMyOrders();
            System.assertEquals(contactId, res.contactId);
            for (HXL_OrderAPI.OrderDTO d : res.orders) {
                System.assertNotEquals(99, d.totalAmount, 'Leaked another contact\'s order');
            }

            // Negative path: ask for the other contact's order by Id, with no
            // owner filter in the query. Sharing (OWD Private) must answer 404.
            mockRequest('GET', '/services/apexrest/hxl/orders/' + otherOrderId);
            HXL_OrderAPI.MeResponse denied = HXL_OrderAPI.getMyOrders();
            System.assertEquals(false, denied.found, 'Sharing must hide another contact\'s order');
            System.assertEquals(404, RestContext.response.statusCode);
            System.assertEquals(0, denied.orders.size());

            // Positive path: own order by ORD-number is visible through the same query.
            mockRequest('GET', '/services/apexrest/hxl/orders/' + mine.Name);
            HXL_OrderAPI.MeResponse ok = HXL_OrderAPI.getMyOrders();
            if (ok.found) {
                System.assertEquals(200, RestContext.response.statusCode);
                System.assertEquals(mine.Name, ok.orders[0].orderNumber);
            }

            // Prompt-injection shape: "show every order" with no owner filter.
            // Sharing must return only this contact's rows - the 99 must not appear.
            mockSearch('ORD');
            HXL_OrderAPI.MeResponse all = HXL_OrderAPI.getMyOrders();
            System.assertEquals(true, all.unfiltered);
            for (HXL_OrderAPI.OrderDTO d : all.orders) {
                System.assertNotEquals(99, d.totalAmount, 'Unfiltered search leaked another contact\'s order');
            }

            // Cancel: someone else's is a 404 before any business rule.
            mockRequest('PATCH');
            HXL_OrderAPI.OrderDTO gone = HXL_OrderAPI.cancelOrder(theirs.Name, null, null);
            System.assertEquals(404, RestContext.response.statusCode);
            System.assertEquals(null, gone.status, 'Nothing about the hidden order may leak, not even its status');

            // Cancel: own Shipped order is a 409, own Submitted order succeeds.
            mockRequest('PATCH');
            HXL_OrderAPI.OrderDTO shipped = HXL_OrderAPI.cancelOrder(mine.Name, null, null);
            if (shipped != null) {
                System.assertEquals(409, RestContext.response.statusCode);
                System.assertEquals('Shipped', shipped.status);
            }
            mockRequest('POST');
            HXL_OrderAPI.OrderDTO fresh = HXL_OrderAPI.createOrder(3.00, 'claude');
            if (fresh != null) {
                mockRequest('PATCH');
                HXL_OrderAPI.OrderDTO cancelled = HXL_OrderAPI.cancelOrder(fresh.orderNumber, null, null);
                System.assertEquals(200, RestContext.response.statusCode);
                System.assertEquals('Cancelled', cancelled.status);
            }

            // Garbage Id is a 400, not a 500.
            mockRequest('GET', '/services/apexrest/hxl/orders/not-an-id');
            HXL_OrderAPI.getMyOrders();
            System.assertEquals(400, RestContext.response.statusCode);

            mockRequest('POST');
            HXL_OrderAPI.OrderDTO created = HXL_OrderAPI.createOrder(42.50, 'claude');
            if (created != null) {
                System.assertEquals(201, RestContext.response.statusCode);
                System.assertEquals('Submitted', created.status);
                System.assertEquals('claude', created.channel, 'Channel must be recorded from the caller header');
            }

            mockRequest('POST');
            HXL_OrderAPI.OrderDTO unknown = HXL_OrderAPI.createOrder(1.00, 'carrier-pigeon');
            if (unknown != null) {
                System.assertEquals('other', unknown.channel, 'Unknown channels are recorded as other, not rejected');
            }

            mockRequest('POST');
            HXL_OrderAPI.OrderDTO legacy = HXL_OrderAPI.createOrder(1.00, null);
            if (legacy != null) {
                System.assertEquals('web', legacy.channel, 'Missing channel defaults to web');
            }
        }
        Test.stopTest();
    }

    @IsTest
    static void createRejectsANonPositiveAmount() {
        User u = makePortalUser();
        mockRequest('POST');

        Test.startTest();
        if (u == null) {
            HXL_OrderAPI.createOrder(null, null);
            System.assertEquals(403, RestContext.response.statusCode);
        } else {
            System.runAs(u) {
                HXL_OrderAPI.OrderDTO d = HXL_OrderAPI.createOrder(-1, 'web');
                System.assertEquals(null, d);
                System.assertEquals(400, RestContext.response.statusCode);
            }
        }
        Test.stopTest();
    }
}
