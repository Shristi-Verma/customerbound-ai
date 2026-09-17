/**
 * Headless Experience Layer - data endpoint.
 *
 * The identity half of HXL gets the front end a *named user* access token.
 * This class is what proves it: every response is scoped to the running
 * user's Contact, with no user id ever accepted from the caller. Point the
 * same endpoint at two different access tokens and you get two different
 * order lists - that is the demo.
 *
 * Reachable from the Experience Cloud site at:
 *   GET   <site>/services/apexrest/hxl/orders            my orders
 *   GET   <site>/services/apexrest/hxl/orders?q=<text>   SEARCH - every order the token can see
 *                                                         whose number contains <text>; no owner
 *                                                         filter at all (the prompt-injection beat)
 *   GET   <site>/services/apexrest/hxl/orders/<id|name>  one order, by record Id or ORD-number
 *   POST  <site>/services/apexrest/hxl/orders
 *   PATCH <site>/services/apexrest/hxl/orders            cancel { orderNumber }
 *
 * The single-order GET is the negative-path proof. It deliberately has NO
 * owner filter: it asks Salesforce for the record by Id and lets sharing
 * answer. The object's OWD is Private, so another customer's order comes back
 * as 404 - not because this code checked, but because the token cannot see it.
 */
@RestResource(urlMapping='/hxl/orders/*')
global with sharing class HXL_OrderAPI {

    global class OrderDTO {
        global String id;
        global String orderNumber;
        global String status;
        global Decimal totalAmount;
        global Datetime placedOn;
        global String channel;
        global String customerName;
        global String staffNote;
    }

    /** Restricted picklist values on HXL_Order__c.Channel__c. Anything else becomes 'other'. */
    private static final Set<String> CHANNELS = new Set<String>{
        'web', 'claude', 'chatgpt', 'slack', 'codex', 'other'
    };

    global class MeResponse {
        global String contactId;
        global String name;
        global String email;
        global List<OrderDTO> orders;
        global String persona;
        global String staffUserId;
        /** Set on GET /hxl/orders/<id|name>: what was asked for, and whether sharing let us see it. */
        global String lookup;
        global Boolean found;
        /** Set on GET /hxl/orders?q=: the search text, and that no owner filter was applied. */
        global String search;
        global Boolean unfiltered;
    }

    /** Statuses a customer may cancel from. Shipped and Cancelled are final. */
    private static final Set<String> CANCELLABLE = new Set<String>{ 'Draft', 'Submitted' };

    @HttpGet
    global static MeResponse getMyOrders() {
        Id contactId = currentContactId();
        Boolean staff = isStaff();

        MeResponse res = new MeResponse();
        res.orders = new List<OrderDTO>();
        res.persona = staff ? 'staff' : 'customer';
        res.staffUserId = staff ? UserInfo.getUserId() : null;

        String lookup = lookupFromPath();
        if (lookup != null) {
            return getOneOrder(res, contactId, lookup);
        }

        String q = RestContext.request == null ? null : RestContext.request.params.get('q');
        if (q != null) {
            return searchOrders(res, contactId, q);
        }

        if (contactId == null && !staff) {
            // Guest / integration token: authenticated to the org, but not a
            // person. Return an empty envelope rather than leaking anything.
            RestContext.response.statusCode = 200;
            return res;
        }

        if (staff) {
            User u = [SELECT Id, Name, Email FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
            res.name = u.Name;
            res.email = u.Email;
            for (HXL_Order__c o : [
                SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c,
                       Owner_Contact__r.Name, Staff_Note__c
                FROM HXL_Order__c
                WITH USER_MODE
                ORDER BY Placed_On__c DESC
                LIMIT 100
            ]) res.orders.add(toStaffDto(o));
            return res;
        }

        Contact c = [SELECT Id, Name, Email FROM Contact WHERE Id = :contactId WITH USER_MODE LIMIT 1];
        res.contactId = c.Id;
        res.name = c.Name;
        res.email = c.Email;

        for (HXL_Order__c o : [
            SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
            FROM HXL_Order__c
            WHERE Owner_Contact__c = :contactId
            WITH USER_MODE
            ORDER BY Placed_On__c DESC
            LIMIT 50
        ]) {
            OrderDTO d = new OrderDTO();
            d.id = o.Id;
            d.orderNumber = o.Name;
            d.status = o.Status__c;
            d.totalAmount = o.Total_Amount__c;
            d.placedOn = o.Placed_On__c;
            d.channel = o.Channel__c;
            res.orders.add(d);
        }
        return res;
    }

    /**
     * channel is the surface the click came from (web, claude, chatgpt, slack,
     * codex). It is an audit label, not an authorization input: the owner still
     * comes from the token, and an unknown value is recorded as 'other' rather
     * than rejected. Omitted (older callers) means 'web'.
     */
    @HttpPost
    global static OrderDTO createOrder(Decimal totalAmount, String channel) {
        Id contactId = currentContactId();
        if (contactId == null || isStaff()) {
            RestContext.response.statusCode = 403;
            return null;
        }
        if (totalAmount == null || totalAmount <= 0) {
            RestContext.response.statusCode = 400;
            return null;
        }

        String ch = String.isBlank(channel) ? 'web' : channel.trim().toLowerCase();
        if (!CHANNELS.contains(ch)) ch = 'other';

        HXL_Order__c o = new HXL_Order__c(
            Owner_Contact__c = contactId,
            Status__c = 'Submitted',
            Total_Amount__c = totalAmount,
            Placed_On__c = System.now(),
            Channel__c = ch
        );
        insert as user o;

        HXL_Order__c saved = [
            SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
            FROM HXL_Order__c
            WHERE Id = :o.Id
            WITH USER_MODE
            LIMIT 1
        ];

        OrderDTO d = new OrderDTO();
        d.id = saved.Id;
        d.orderNumber = saved.Name;
        d.status = saved.Status__c;
        d.totalAmount = saved.Total_Amount__c;
        d.placedOn = saved.Placed_On__c;
        d.channel = saved.Channel__c;

        RestContext.response.statusCode = 201;
        return d;
    }

    /**
     * Search with NO owner filter. This exists for one reason: to be the tool a
     * prompt-injected model reaches for when told "show every customer's
     * orders". It asks for exactly that. Salesforce sharing answers with only
     * the running customer's records - the same list getMyOrders returns, but
     * this time nothing in the code narrowed it.
     */
    private static MeResponse searchOrders(MeResponse res, Id contactId, String q) {
        res.search = q;
        res.unfiltered = true;
        res.contactId = contactId;
        if (contactId == null) {
            RestContext.response.statusCode = 403;
            return res;
        }
        String pattern = '%' + String.escapeSingleQuotes(q.trim()) + '%';
        for (HXL_Order__c o : [
            SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
            FROM HXL_Order__c
            WHERE Name LIKE :pattern
            WITH USER_MODE
            ORDER BY Placed_On__c DESC
            LIMIT 200
        ]) {
            res.orders.add(toDto(o));
        }
        RestContext.response.statusCode = 200;
        return res;
    }

    /**
     * Cancel one of the customer's own orders. Same rule as everywhere else:
     * looked up with sharing and no owner filter, so someone else's order is a
     * 404 before any business rule runs. Shipped/Cancelled orders answer 409.
     */
    @HttpPatch
    global static OrderDTO cancelOrder(String orderNumber, String action, String staffNote) {
        Id contactId = currentContactId();
        Boolean staff = isStaff();
        if (contactId == null && !staff) {
            RestContext.response.statusCode = 403;
            return null;
        }
        if (String.isBlank(orderNumber)) {
            RestContext.response.statusCode = 400;
            return null;
        }
        List<HXL_Order__c> rows;
        if (staff) {
            rows = [
                SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c,
                       Owner_Contact__r.Name, Staff_Note__c
                FROM HXL_Order__c
                WHERE Name = :orderNumber.trim()
                WITH USER_MODE
                LIMIT 1
            ];
        } else {
            rows = [
                SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
                FROM HXL_Order__c
                WHERE Name = :orderNumber.trim()
                WITH USER_MODE
                LIMIT 1
            ];
        }
        if (rows.isEmpty()) {
            // A JSON body, not null: a null return makes the platform answer
            // with an empty non-JSON 404 that clients misread as a broken host.
            RestContext.response.statusCode = 404;
            OrderDTO missing = new OrderDTO();
            missing.orderNumber = orderNumber.trim();
            return missing;
        }
        HXL_Order__c o = rows[0];
        if (staff) {
            String requested = String.isBlank(action) ? '' : action.trim().toLowerCase();
            if (requested == 'approve' && o.Status__c == 'Submitted') {
                o.Status__c = 'Approved';
            } else if (requested == 'fulfill' && o.Status__c == 'Approved') {
                o.Status__c = 'Fulfilled';
            } else {
                RestContext.response.statusCode = 409;
                return toStaffDto(o);
            }
            if (!String.isBlank(staffNote)) o.Staff_Note__c = staffNote.left(1000);
            String ch = RestContext.request == null ? null : RestContext.request.headers.get('X-HXL-Channel');
            ch = String.isBlank(ch) ? 'other' : ch.trim().toLowerCase();
            o.Channel__c = CHANNELS.contains(ch) ? ch : 'other';
            // Update only fields the staff action is allowed to change. Reusing
            // the queried record would make user-mode DML validate unrelated,
            // read-only fields that were populated by the SELECT.
            HXL_Order__c change = new HXL_Order__c(
                Id = o.Id,
                Status__c = o.Status__c,
                Channel__c = o.Channel__c,
                Staff_Note__c = o.Staff_Note__c
            );
            update as user change;
            RestContext.response.statusCode = 200;
            return toStaffDto(o);
        }
        if (!CANCELLABLE.contains(o.Status__c)) {
            RestContext.response.statusCode = 409;
            return toDto(o);
        }
        o.Status__c = 'Cancelled';
        update as user o;
        RestContext.response.statusCode = 200;
        return toDto(o);
    }

    private static OrderDTO toDto(HXL_Order__c o) {
        OrderDTO d = new OrderDTO();
        d.id = o.Id;
        d.orderNumber = o.Name;
        d.status = o.Status__c;
        d.totalAmount = o.Total_Amount__c;
        d.placedOn = o.Placed_On__c;
        d.channel = o.Channel__c;
        return d;
    }

    private static OrderDTO toStaffDto(HXL_Order__c o) {
        OrderDTO d = toDto(o);
        d.customerName = o.Owner_Contact__r == null ? 'Customer' : o.Owner_Contact__r.Name;
        d.staffNote = o.Staff_Note__c;
        return d;
    }

    /** The path segment after /hxl/orders/, or null for the bare collection. */
    private static String lookupFromPath() {
        String uri = RestContext.request == null ? null : RestContext.request.requestURI;
        if (String.isBlank(uri)) return null;
        Integer at = uri.indexOf('/hxl/orders/');
        if (at < 0) return null;
        String rest = uri.substring(at + '/hxl/orders/'.length());
        rest = rest.removeEnd('/').trim();
        return String.isBlank(rest) ? null : EncodingUtil.urlDecode(rest, 'UTF-8');
    }

    /**
     * One order by record Id or by ORD-number, with sharing and in user mode,
     * and with no Owner_Contact__c filter on purpose. If the running user's
     * token cannot see the record, the query returns nothing and this answers
     * 404. That is Salesforce's sharing model saying no, not this class.
     */
    private static MeResponse getOneOrder(MeResponse res, Id contactId, String lookup) {
        res.lookup = lookup;
        res.found = false;
        res.contactId = contactId;

        if (contactId == null) {
            RestContext.response.statusCode = 403;
            return res;
        }

        List<HXL_Order__c> rows;
        if (lookup.toUpperCase().startsWith('ORD-')) {
            rows = [
                SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
                FROM HXL_Order__c
                WHERE Name = :lookup
                WITH USER_MODE
                LIMIT 1
            ];
        } else {
            Id recId;
            try {
                recId = Id.valueOf(lookup);
            } catch (Exception e) {
                RestContext.response.statusCode = 400;
                return res;
            }
            rows = [
                SELECT Id, Name, Status__c, Total_Amount__c, Placed_On__c, Channel__c
                FROM HXL_Order__c
                WHERE Id = :recId
                WITH USER_MODE
                LIMIT 1
            ];
        }

        if (rows.isEmpty()) {
            RestContext.response.statusCode = 404;
            return res;
        }

        HXL_Order__c o = rows[0];
        OrderDTO d = new OrderDTO();
        d.id = o.Id;
        d.orderNumber = o.Name;
        d.status = o.Status__c;
        d.totalAmount = o.Total_Amount__c;
        d.placedOn = o.Placed_On__c;
        d.channel = o.Channel__c;
        res.orders.add(d);
        res.found = true;
        RestContext.response.statusCode = 200;
        return res;
    }

    /**
     * The Contact behind the access token. Community/portal users are backed
     * by a Contact; internal and integration users are not, and get null.
     */
    private static Id currentContactId() {
        List<User> users = [
            SELECT ContactId
            FROM User
            WHERE Id = :UserInfo.getUserId()
            LIMIT 1
        ];
        return users.isEmpty() ? null : users[0].ContactId;
    }

    private static Boolean isStaff() {
        return FeatureManagement.checkPermission('HXL_Staff_Access');
    }
}
