﻿import Dexie from 'dexie';
import {module, test, equal, ok, deepEqual} from 'QUnit';
import {resetDatabase, supports} from './dexie-unittest-utils';

module("upgrading");

var Promise = Dexie.Promise;

// Ensure Dexie verno and backing IDB version are as expected.
function checkDBVersion(db, version) {
    equal(db.verno, version, `DB should be version ${version}`);
    equal(db.backendDB().version, version * 10,
          `idb should be version ${version * 10}`);
}

// Ensure object store names are as expected.
function checkDBObjectStores(db, baseTables, expected) {
    // Add baseTables.
    expected = expected.concat(baseTables).sort();
    // Already sorted.
    var idbNames = [...db.backendDB().objectStoreNames];
    var dexieNames = db.tables.map(t => t.name).sort();
    deepEqual(dexieNames,
              expected,
              "Dexie.tables must match expected.");
    if (supports("deleteObjectStoreAfterRead")) {
        // Special treatment for IE/Edge where Dexie avoids deleting
        // the actual store to avoid a bug.
        // This special treatment in the unit tests may not need to
        // be here if we can work around Dexie issue #1.
        deepEqual(idbNames,
                expected,
                "IDB object stores must match expected.");
    }
}

function checkTransactionObjectStores(t, baseTables, expected) {
    // Add baseTables.
    expected = expected.concat(baseTables).sort();
    deepEqual(t.storeNames.slice().sort(),
              expected,
              "Transaction stores must match expected.");
}

// Get tables not matching expected.
function getBaseTables(db, expected = []) {
    let tables = db.tables.map(t => t.name);
    return tables.filter(t => !expected.includes(t));
}

// tests:
// * separate tests with a commented line of --- up to column 80.
// * put test result checking as a then of the relevant db.open call.
// * db.close at the top of a new section.
// another top-level then should indicate another part of the sequence
// of upgrade actions.
// put db.delete() in its own clause.
test("upgrade", (assert) => {
    let done = assert.async();
    // To test:
    // V Start with empty schema
    // V Add indexes
    // V Remove indexes
    // V Specify the changed object stores only
    // V Run an upgrader function
    // V Run a series of upgrader functions (done when creating DB from scratch with ALL version specs and at least two of them have upgrader functions)
    // V Add object store
    // V Remove object store
    // V Reverse order of specifying versions
    // V Delete DB and open it with ALL version specs specified (check it will run in sequence)
    // V Delete DB and open it with all version specs again but in reverse order
    var DBNAME = "TestDBUpgrade";
    var db = null;
    // Instead of expecting an empty database to have 0 tables, we read
    // how many an empty database has.
    // Reason: Addons may add meta tables.
    var baseTables = [];


    Dexie.delete(DBNAME).then(() => {
        // --------------------------------------------------------------------
        // Test: Empty schema
        db = new Dexie(DBNAME);
        db.version(1).stores({});
        return db.open().then(() => {
            ok(true, "Could create empty database without any schema");
            // Set so add-on tables don't invalidate checks.
            baseTables = getBaseTables(db);
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Adding version.
        db = new Dexie(DBNAME);
        db.version(1).stores({});
        db.version(2).stores({ store1: "++id" });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 2");
            checkDBVersion(db, 2);
            equal(db.table("store1").schema.primKey.name, "id",
                  "Primary key is 'id'");
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Adding an index to a store
        db = new Dexie(DBNAME);
        db.version(1).stores({});
        db.version(2).stores({ store1: "++id" });
        // Adding the name index
        db.version(3).stores({ store1: "++id,name" });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 3 (adding an index to a store)");
            checkDBVersion(db, 3);
        });
    }).then(() => {
        // Testing that the added index is working indeed:
        return db.transaction('rw', "store1", function () {
            db.store1.add({ name: "apa" });
            db.store1.where("name").equals("apa").count(function (count) {
                equal(count, 1,
                    "Apa was found by its new index (The newly added index really works!)");
            });
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Testing:
        //  1. Place latest version first (order should not matter)
        //  2. Removing the 'name' index.
        db = new Dexie(DBNAME);
        db.version(4).stores({ store1: "++id" });
        db.version(3).stores({ store1: "++id,name" });
        db.version(2).stores({ store1: "++id" });
        db.version(1).stores({});
        return db.open().then(() => {
            ok(true, "Could upgrade to version 4 (removing an index)");
            checkDBVersion(db, 4);
            equal(db.tables[0].schema.indexes.length, 0, "No indexes in schema now when 'name' index was removed");
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Running an upgrader function.
        db = new Dexie(DBNAME);
        var upgraders = 0;
        // (Need not to specify earlier versions than 4 because 'I have no users out there running on version below 4'.)
        db.version(4).stores({ store1: "++id" });
        db.version(5).stores({ store1: "++id,&email" }).upgrade(function (trans) {
            upgraders++;
            var counter = 0;
            db.store1.toCollection().modify(function (obj) {
                // Since we have a new primary key we must make sure it's unique on all objects
                obj.email = "user" + (++counter) +"@abc.com";
            });
        });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 5 where an upgrader function was applied");
            checkDBVersion(db, 5);
            equal(upgraders, 1, "1 upgrade function should have run.");
        });
    }).then(() => {
        return db.table("store1").toArray().then(array => {
            equal(array.length, 1,
                "We still have the object created in version 3 there");
            equal(array[0].email, "user1@abc.com", "The object got its upgrade function running");
            equal(array[0].id, 1, "The object still has the same primary key");
            equal(array[0].name, "apa", "The object still has the name 'apa' that was given to it when it was created");
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Changing a property of an index
        db = new Dexie(DBNAME);
        db.version(5).stores({ store1: "++id,&email" });
        // Changing email index from unique to multi-valued
        db.version(6).stores({ store1: "++id,*email" }).upgrade(t => {
            t.table("store1").toCollection().modify(obj => {
                // Turning single-valued unique email into an array of
                // emails.
                obj.email = [obj.email];
            });
        }); 
        return db.open().then(() => {
            ok(true, "Could upgrade to version 6");
            checkDBVersion(db, 6);
            checkDBObjectStores(db, baseTables, ["store1"]);
        });
    }).then(() => {
        return db.table('store1').get(1, function (apaUser) {
            ok(Array.isArray(apaUser.email), "email is now an array");
            equal(apaUser.email[0], "user1@abc.com", "First email is user1@abc.com");
        });
    }).then(() => {
        // Test that it is now ok to add two different users with the same email, since we have removed the uniqueness requirement of the index
        return db.table('store1').add({ name: "apa2", email: ["user1@abc.com"] });
    }).then(() => {
        return db.table('store1').toArray().then(array => {
            equal(array.length, 2, "There are now two users in db");
            equal(array[0].email[0], array[1].email[0], "The two users share the same email value");
        });
    }).then((array) => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Only changed object stores need to be specified.
        db = new Dexie(DBNAME);
        // No need to specify an upgrade function when we know it's not
        // gonna run (we are already on ver 5)
        db.version(6).stores({ store1: "++id,*email" });
        db.version(7).stores({ store2: "uuid" });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 7");
            checkDBVersion(db, 7);
            checkDBObjectStores(db, baseTables, ["store1", "store2"]);
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Object store removal.
        db = new Dexie(DBNAME);
        // Need to keep version 6 or add its missing stores to version 7,
        // 7. Choosing to keep version 6.
        db.version(6).stores({ store1: "++id,*email" });
        db.version(7).stores({ store2: "uuid" });
        // Deleting a version.
        db.version(8).stores({ store1: null });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 8 - deleting an object store");
            checkDBVersion(db, 8);
            checkDBObjectStores(db, baseTables, ["store2"]);
        });
    }).then(() => {
        db.close();
        // --------------------------------------------------------------------
        // Test: Use a removed object store while running an upgrade function.
        db = new Dexie(DBNAME);
        db.version(7).stores({ store2: "uuid" });
        db.version(8).stores({ store1: null });
        db.version(9).stores({ store1: "++id,email" });
        db.version(10).stores({ store1: null }).upgrade(t => {
            checkTransactionObjectStores(t, baseTables, ["store1", "store2"]);
            // TODO: actually use the object store.
            ok(true, "Upgrade transaction contains deleted store.");
        });
        return db.open().then(() => {
            ok(true, "Could upgrade to version 10 - deleting an object store with upgrade function");
            checkDBVersion(db, 10);
            checkDBObjectStores(db, baseTables, ["store2"]);
        });
    }).then(() => {
        // Reset.
        return db.delete();
    }).then(() => {
        // --------------------------------------------------------------------
        // Test:
        // 1. Upgrade transactions should have the correct object
        //    stores available. (future version)
        db = new Dexie(DBNAME);
        db.version(1).stores({
            store1: "++id,name"
        });
        let names = [
            "A B",
            "C D",
            "E F",
            "G H"
        ];
        return db.open().then(() => {
            // Populate db.
            return db.store1.bulkPut(names.map(name => ({ name: name })));
        });
    }).then(() => {
        db.close();
        // Add upgrade functions.
        // Track number of upgrade functions run.
        var upgraders = 0;
        db.version(2).stores({
            store2: "++id,firstname,lastname"
        }).upgrade(t => {
            checkTransactionObjectStores(t, baseTables,
                ["store1", "store2"]);
            ok(true, "Upgrade transaction has stores deleted later.");
            db.store1;
            t.store1.each((item) => {
                let [first_name, last_name] = item.name.split(' ');
                t.store2.put({ firstname: first_name, lastname: last_name });
            });
            upgraders++;
        });
        db.version(3).stores({
            store1: null,
            store3: "++id,person_id"
        }).upgrade(t => {
            checkTransactionObjectStores(t, baseTables,
                ["store1", "store2", "store3"]);
            t.store1.count().then((n) => {
                equal(n, 4, "Number of objects in deleted object store is as expected");
            })
            t.store2.each((item) => {
                t.store3.put({ person_id: item.id, age: Math.random() * 100 });
            });
            upgraders++;
        });
        return db.open().then(() => {
            checkDBVersion(db, 3);
            equal(upgraders, 2, "2 upgrade functions should have run.");
            checkDBObjectStores(db, baseTables, ["store2", "store3"]);
            db.table('store2').where('firstname').equals('A').count().then((n) => {
                equal(n, 1, "Object could be retrieved from new object store.");
            });
        });
    }).then(() => {
        return db.delete();
    }).then(() => {
        // --------------------------------------------------------------------
        // Test: Dexie identifies the correct table name and schema given a
        // sequence of versions to go through.
        db = new Dexie(DBNAME);
        db.version(1).stores({});
        db.version(2).stores({ store1: "++id" });
        // Adding the name index
        db.version(3).stores({ store1: "++id,name" });
        db.version(4).stores({ store1: "++id" });
        db.version(5).stores({ store1: "++id,&email" }).upgrade(t => {
            var counter = 0;
            t.table("store1").toCollection().modify(obj => {
                // Since we have a new primary key we must make sure
                // it's unique on all objects
                obj.email = "user" + (++counter) + "@abc.com";
            });
        });
        // Changing email index from unique to multi-valued
        db.version(6).stores({ store1: "++id,*email" }).upgrade(t => {
            t.table("store1").toCollection().modify(obj => {
                // Turning single-valued unique email into an array of
                // emails.
                obj.email = [obj.email];
            });
        });
        db.version(7).stores({ store2: "uuid" });
        db.version(8).stores({ store1: null });
        return db.open().then(() => {
            ok(true, "Could create new database");
            checkDBVersion(db, 8);
            checkDBObjectStores(db, baseTables, ["store2"]);
            equal(db.table("store2").schema.primKey.name, "uuid", "The prim key is uuid");
        });
    }).then(() => {
        return db.delete();
    }).then(() => {
        // --------------------------------------------------------------------
        // Test: Order of version declaration should not matter.
        db = new Dexie(DBNAME);
        db.version(8).stores({ store1: null });
        db.version(7).stores({ store2: "uuid" });
        db.version(6).stores({ store1: "++id,*email" }).upgrade(function () { // Changing email index from unique to multi-valued
            db.store1.toCollection().modify(function (obj) {
                obj.email = [obj.email]; // Turning single-valued unique email into an array of emails.
            });
        });
        db.version(5).stores({ store1: "++id,&email" }).upgrade(function () {
            var counter = 0;
            db.store1.toCollection().modify(function (obj) {
                // Since we have a new primary key we must make sure it's unique on all objects
                obj.email = "user" + (++counter) + "@abc.com";
            });
        });
        db.version(4).stores({ store1: "++id" });
        db.version(3).stores({ store1: "++id,name" }); // Adding the name index
        db.version(2).stores({ store1: "++id" });
        db.version(1).stores({});
        return db.open().then(() => {
            ok(true, "Could create new database");
            checkDBVersion(db, 8);
            checkDBObjectStores(db, baseTables, ["store2"]);
            equal(db.table("store2").schema.primKey.name, "uuid", "The prim key is uuid");
        });
    }).catch((err) => {
        ok(false, `Error: ${err}\n${err.stack}`);
    }).finally(() => {
        if (db) db.close();
        done();
    });
});

test("Previous definitions not needed for upgrade", (assert) => {
    let done = assert.async();
    let name = "upgrade";
    let baseTables;
    let db;
    let data = [
        { name: 'a' },
        { name: 'b' },
        { name: 'c' }
    ];

    Dexie.delete(name).then(() => {
        db = new Dexie(name);
        db.version(1).stores({
            person: 'id++,name'
        });
        return db.open().then(() => {
            baseTables = getBaseTables(db, ['person']);
            checkDBVersion(db, 1);
            checkDBObjectStores(db, baseTables, ['person']);
            return db.person.bulkAdd(data);
        });
    }).then(() => {
        db.close();
        let expected = ['person', 'users'];
        // Recreate so previous instance state is gone.
        db = new Dexie(name);
        // Only define latest version.
        db.version(2).stores({
            users: 'id++,name,age'
        }).upgrade((t) => {
            checkTransactionObjectStores(t, baseTables, expected);
            t.table('person').each((record) => {
                t.users.add({
                    name: record.name
                });
            });
        });

        return db.open().then(() => {
            checkDBVersion(db, 2);
            checkDBObjectStores(db, baseTables, expected);
            return Promise.all([db.users.count(), db.person.count()])
            .then((counts) => {
                equal(counts[0], data.length,
                    'Users table should have all records');
                equal(counts[1], data.length,
                    'Person table should have all records');
            });
        });
    }).then(done);
});

test("Issue #30 - Problem with existing db", (assert) => {
    let done = assert.async();
    if (!supports("compound+multiEntry")) {
        ok(true, "SKIPPED - COMPOUND + MULTIENTRY UNSUPPORTED");
        return done();
    }
    ///<var type="Dexie" />
    var db; // Will be used as a migrated version of the db.

    // Start by deleting the db if it exists:
    Dexie.delete("raw-db").then(function () {

        // Create a bare-bone indexedDB database with custom indexes of various kinds.
        return new Dexie.Promise(function (resolve, reject) {
            var indexedDB = Dexie.dependencies.indexedDB;
            var rawdb, req;

            function error(e) {
                if (rawdb) rawdb.close();
                reject(e.target.error);
            }

            req = indexedDB.open("raw-db", 2);
            req.onupgradeneeded = function (ev) {
                try {
                    console.log("onupgradeneeded called");
                    rawdb = req.result;
                    // Stores
                    var people = rawdb.createObjectStore("people", {keyPath: "_id", autoIncrement: false});
                    var messages = rawdb.createObjectStore("messages", {autoIncrement: true});
                    var umbrellas = rawdb.createObjectStore("umbrellas", {keyPath: ["date", "time"]});
                    // Indexes:
                    messages.createIndex("text_index", "text", {unique: false, multiEntry: false});
                    messages.createIndex("words_index", "words", {unique: false, multiEntry: true});
                    messages.createIndex("id_index", "id", {unique: true, multiEntry: false});
                    umbrellas.createIndex("size_color_index", ["size", "color"], {
                        unique: false,
                        multiEntry: false
                    });
                    // Data:
                    people.add({_id: "9AF56447-66CE-470A-A70F-674A32EF2D51", name: "Kalle"});
                    messages.add({text: "Here is a text", words: ["here", "is", "a", "text"], id: 1});
                    umbrellas.add({
                        date: "2014-11-20",
                        time: "22:18",
                        size: 98,
                        color: "pink",
                        name: "My Fine Umbrella!"
                    });
                } catch (ex) {
                    if (rawdb) rawdb.close();
                    reject(ex);
                }
            }
            req.onsuccess = function () {
                console.log("onsuccess called");
                rawdb = req.result;

                rawdb.close();

                resolve();
            };
            req.onerror = error;
        });
    }).then(function () {
        // Try open the database using Dexie:
        db = new Dexie("raw-db", {addons: []}); // Explicitely don't use addons here. Syncable would fail to open an existing db.
        db.version(0.2).stores({
            people: "_id",
            messages: "++,text,words,id,[size+color]",
            umbrellas: "[date+time],[size+color]"
        });
        return db.open();
    }).then(function () {
        // Verify "people" data
        return db.people.toArray(function (people) {
            equal(people.length, 1, "One person in people");
            equal(people[0].name, "Kalle", "The persons' name is Kalle");
        });
    }).then(function () {
        // Verify "messages" data
        return db.messages.toArray(function (messages) {
            equal(messages.length, 1, "One message in messages");
            equal(messages[0].text, "Here is a text", "The message has the correct text");
            equal(messages[0].words.length, 4, "The message has 4 words");
        });
    }).then(function () {
        // Verify "umbrellas" data
        return db.umbrellas.toArray(function (umbrellas) {
            equal(umbrellas.length, 1, "One umbrella in umbrellas");
            equal(umbrellas[0].name, "My Fine Umbrella!", "The umbrella has the correct name");
            equal(umbrellas[0].date, "2014-11-20", "The umbrella has the correct date");
            equal(umbrellas[0].time, "22:18", "The umbrella has the correct time");
            equal(umbrellas[0].size, 98, "The umbrella has the currect size");
            equal(umbrellas[0].color, "pink", "The umbrella has the correct color");
        });
    }).then(function () {
        // Test messages indexes
        return db.messages.orderBy("text").first(function (message) {
            ok(!!message, "Could find a message when iterating the 'text' index");
        });
    }).then(function () {
        // Test words index
        return db.messages.where("words").equals("is").first(function (message) {
            ok(!!message, "Could find a message when querying the 'words' index");
        });
    }).then(function () {
        // Test id index
        return db.messages.where("id").equals(1).count(function (count) {
            equal(count, 1, "Could count id's");
        });
    }).then(function () {
        // Test umbrella compound primary key
        return db.umbrellas.get(["2014-11-20", "22:18"], function (umbrella) {
            ok(!!umbrella, "Umbrella was found by compound primary key");
            equal(umbrella.color, "pink", "Umbrella has the correct color");
        });
    }).then(function () {
        // Test umbrella compound index
        return db.umbrellas.where("[size+color]").above([98, "pina"]).count(function (count) {
            equal(count, 1, "Could count umbrellas based on a query on compound index");
        });
    }).then(function () {
        // Now, let's upgrade the migrated database
        db.close();
        db = new Dexie("raw-db");
        // First, as required with Dexie so far, specify the existing stores:
        db.version(0.2).stores({
            people: "_id",
            messages: "++,text,words,id,[size+color]",
            umbrellas: "[date+time],[size+color]"
        });
        // Then, add the 'name' index to people:
        db.version(3).stores({
            people: "_id,name"
        });
        return db.open();
    }).then(function () {
        // Now test the new name index:
        return db.people.where("name").equalsIgnoreCase("kalle").first();
    }).then(function (kalle) {
        ok(!!kalle, "Could find at least one object by its name index");
        equal(kalle.name, "Kalle", "The found object was Kalle indeed");
    }).catch(function (err) {
        ok(false, "Error: " + err);
    }).finally(function () {
        if (db) db.close();
        Dexie.delete("raw-db").then(done);
    });
});
