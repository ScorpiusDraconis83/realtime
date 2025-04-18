import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import {
  createClient,
  SupabaseClient,
  RealtimeChannel,
} from "npm:@supabase/supabase-js@2.47.3";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { sleep } from "https://deno.land/x/sleep/mod.ts";

import { JWTPayload, SignJWT } from "https://deno.land/x/jose@v5.9.4/index.ts";
const env = await load();
const url = env["PROJECT_URL"];
const token = env["PROJECT_ANON_TOKEN"];
const jwtSecret = env["PROJECT_JWT_SECRET"];
const realtime = { heartbeatIntervalMs: 500, timeout: 1000 };
const config = { config: { broadcast: { self: true } } };

const signInUser = async (
  supabase: SupabaseClient,
  email: string,
  password: string
) => {
  const { data } = await supabase.auth.signInWithPassword({ email, password });
  return data!.session!.access_token;
};

const stopClient = async (
  supabase: SupabaseClient,
  channels: RealtimeChannel[]
) => {
  await sleep(1);
  channels.forEach((channel) => {
    channel.unsubscribe();
    supabase.removeChannel(channel);
  });
  supabase.realtime.disconnect(1000, "test done");
  supabase.auth.stopAutoRefresh();
  await sleep(1);
};

const executeCreateDatabaseActions = async (
  supabase: SupabaseClient,
  table: string
): Promise<number> => {
  const { data }: any = await supabase
    .from(table)
    .insert([{ value: crypto.randomUUID() }])
    .select("id");
  return data[0].id;
};

const executeModifyDatabaseActions = async (
  supabase: SupabaseClient,
  table: string,
  id: number
) => {
  await supabase
    .from(table)
    .update({ value: crypto.randomUUID() })
    .eq("id", id);

  await supabase.from(table).delete().eq("id", id);
};

const generateJwtToken = async (payload: JWTPayload) => {
  const secret = new TextEncoder().encode(jwtSecret);
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return jwt;
};

describe("broadcast extension", () => {
  it("user is able to receive self broadcast", async () => {
    let supabase = await createClient(url, token, { realtime });

    let result = null;
    let event = crypto.randomUUID();
    let topic = "topic:" + crypto.randomUUID();
    let expectedPayload = { message: crypto.randomUUID() };

    const channel = supabase
      .channel(topic, config)
      .on("broadcast", { event }, ({ payload }) => (result = payload))
      .subscribe(async (status: string) => {
        if (status == "SUBSCRIBED") {
          await channel.send({
            type: "broadcast",
            event,
            payload: expectedPayload,
          });
        }
      });

    await sleep(2);
    await stopClient(supabase, [channel]);
    assertEquals(result, expectedPayload);
  });

  it("user is able to use the endpoint to broadcast", async () => {
    let supabase = await createClient(url, token, { realtime });

    let result = null;
    let event = crypto.randomUUID();
    let topic = "topic:" + crypto.randomUUID();
    let expectedPayload = { message: crypto.randomUUID() };

    const activeChannel = supabase
      .channel(topic, config)
      .on("broadcast", { event }, ({ payload }) => (result = payload))
      .subscribe();
    await sleep(2);
    const unsubscribedChannel = supabase.channel(topic, config);
    await unsubscribedChannel.send({
      type: "broadcast",
      event,
      payload: expectedPayload,
    });

    await sleep(1);
    await stopClient(supabase, [activeChannel, unsubscribedChannel]);
    assertEquals(result, expectedPayload);
  });
});

describe("presence extension", () => {
  it("user is able to receive presence updates", async () => {
    let supabase = await createClient(url, token, { realtime });

    let result: any = [];
    let error = null;
    let topic = "topic:" + crypto.randomUUID();
    let message = crypto.randomUUID();
    let key = crypto.randomUUID();
    let expectedPayload = { message };

    const config = { config: { broadcast: { self: true }, presence: { key } } };
    const channel = supabase
      .channel(topic, config)
      .on("presence", { event: "join" }, ({ key, newPresences }) =>
        result.push({ key, newPresences })
      )
      .subscribe(async (status: string) => {
        if (status == "SUBSCRIBED") {
          const res = await channel.track(expectedPayload, { timeout: 1000 });
          if (res == "timed out") {
            error = res;
          }
        }
      });

    await sleep(2);
    await stopClient(supabase, [channel]);

    let presences = result[0].newPresences[0];
    assertEquals(result[0].key, key);
    assertEquals(presences.message, message);
    assertEquals(error, null);
  });

  it("user is able to receive presence updates on private channels", async () => {
    let supabase = await createClient(url, token, { realtime });
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();

    let result: any = [];
    let error = null;
    let topic = "topic:" + crypto.randomUUID();
    let message = crypto.randomUUID();
    let key = crypto.randomUUID();
    let expectedPayload = { message };

    const config = {
      config: { private: true, broadcast: { self: true }, presence: { key } },
    };
    const channel = supabase
      .channel(topic, config)
      .on("presence", { event: "join" }, ({ key, newPresences }) =>
        result.push({ key, newPresences })
      )
      .subscribe(async (status: string) => {
        if (status == "SUBSCRIBED") {
          const res = await channel.track(expectedPayload, { timeout: 1000 });
          if (res == "timed out") {
            error = res;
          }
        }
      });

    await sleep(2);
    await stopClient(supabase, [channel]);

    let presences = result[0].newPresences[0];
    assertEquals(result[0].key, key);
    assertEquals(presences.message, message);
    assertEquals(error, null);
  });
});

describe("postgres changes extension", () => {
  it("user is able to receive INSERT only events from a subscribed table with filter applied", async () => {
    let supabase = await createClient(url, token, { realtime });
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();
    let result: Array<any> = [];
    let topic = "topic:" + crypto.randomUUID();

    let previousId = await executeCreateDatabaseActions(supabase, "pg_changes");
    await executeCreateDatabaseActions(supabase, "dummy");

    const activeChannel = supabase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${previousId + 1}`,
        },
        (payload) => result.push(payload)
      )
      .subscribe();
    await sleep(4);
    await executeCreateDatabaseActions(supabase, "pg_changes");
    await executeCreateDatabaseActions(supabase, "pg_changes");
    await sleep(4);
    await stopClient(supabase, [activeChannel]);

    assertEquals(result.length, 1);
    assertEquals(result[0].eventType, "INSERT");
    assertEquals(result[0].new.id, previousId + 1);
  });

  it("user is able to receive UPDATE only events from a subscribed table with filter applied", async () => {
    let supabase = await createClient(url, token, { realtime });
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();

    let result: Array<any> = [];
    let topic = "topic:" + crypto.randomUUID();

    let mainId = await executeCreateDatabaseActions(supabase, "pg_changes");
    let fakeId = await executeCreateDatabaseActions(supabase, "pg_changes");
    let dummyId = await executeCreateDatabaseActions(supabase, "dummy");

    const activeChannel = supabase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${mainId}`,
        },
        (payload) => result.push(payload)
      )
      .subscribe();
    await sleep(4);

    executeModifyDatabaseActions(supabase, "pg_changes", mainId);
    executeModifyDatabaseActions(supabase, "pg_changes", fakeId);
    executeModifyDatabaseActions(supabase, "dummy", dummyId);

    await sleep(4);
    await stopClient(supabase, [activeChannel]);

    assertEquals(result.length, 1);
    assertEquals(result[0].eventType, "UPDATE");
    assertEquals(result[0].new.id, mainId);
  });

  it("user is able to receive DELETE only events from a subscribed table with filter applied", async () => {
    let supabase = await createClient(url, token, { realtime });
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();

    let result: Array<any> = [];
    let topic = "topic:" + crypto.randomUUID();

    let mainId = await executeCreateDatabaseActions(supabase, "pg_changes");
    let fakeId = await executeCreateDatabaseActions(supabase, "pg_changes");
    let dummyId = await executeCreateDatabaseActions(supabase, "dummy");

    const activeChannel = supabase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${mainId}`,
        },
        (payload) => result.push(payload)
      )
      .subscribe();
    await sleep(4);

    executeModifyDatabaseActions(supabase, "pg_changes", mainId);
    executeModifyDatabaseActions(supabase, "pg_changes", fakeId);
    executeModifyDatabaseActions(supabase, "dummy", dummyId);

    await sleep(4);
    await stopClient(supabase, [activeChannel]);

    assertEquals(result.length, 1);
    assertEquals(result[0].eventType, "DELETE");
    assertEquals(result[0].old.id, mainId);
  });
});

describe("authorization check", () => {
  it("user using private channel cannot connect if does not have enough permissions", async () => {
    let supabase = await createClient(url, token, { realtime });
    let errMessage: any = null;

    let topic = "topic:" + crypto.randomUUID();

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string, err: any) => {
        if (status == "CHANNEL_ERROR") {
          errMessage = err.message;
        }
      });

    await sleep(1);

    await stopClient(supabase, [channel]);
    assertEquals(
      errMessage,
      `"You do not have permissions to read from this Channel topic: ${topic}"`
    );
  });

  it("user using private channel can connect if they have enough permissions", async () => {
    let topic = "topic:" + crypto.randomUUID();
    let supabase = await createClient(url, token, { realtime });
    let connected = false;
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string) => {
        if (status == "SUBSCRIBED") {
          connected = true;
        }
      });

    await sleep(1);
    await supabase.auth.signOut();
    await stopClient(supabase, [channel]);
    assertEquals(connected, true);
  });

  it("user using private channel for jwt connections can connect if they have enough permissions based on claims", async () => {
    let topic = "jwt_topic:" + crypto.randomUUID();
    let supabase = await createClient(url, token, { realtime });
    let connected = false;
    let claims = { role: "authenticated", sub: "wallet_1" };
    let jwt_token = await generateJwtToken(claims);

    await supabase.realtime.setAuth(jwt_token);

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string, err: any) => {
        if (status == "SUBSCRIBED") {
          connected = true;
        }
      });

    await sleep(1);
    await stopClient(supabase, [channel]);
    assertEquals(connected, true);
  });
});

describe("broadcast changes", () => {
  const table = "broadcast_changes";
  const id = crypto.randomUUID();
  const originalValue = crypto.randomUUID();
  const updatedValue = crypto.randomUUID();
  let insertResult: any, updateResult: any, deleteResult: any;

  it("authenticated user receives insert broadcast change from a specific topic based on id", async () => {
    let supabase = await createClient(url, token, { realtime });
    await signInUser(supabase, "filipe@supabase.io", "test_test");
    await supabase.realtime.setAuth();

    const channel = supabase
      .channel("topic:test", { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, (res) => (insertResult = res))
      .on("broadcast", { event: "DELETE" }, (res) => (deleteResult = res))
      .on("broadcast", { event: "UPDATE" }, (res) => (updateResult = res))
      .subscribe(async (status) => {
        if (status == "SUBSCRIBED") {
          await supabase.from(table).insert({ value: originalValue, id });

          await supabase
            .from(table)
            .update({ value: updatedValue })
            .eq("id", id);

          await supabase.from(table).delete().eq("id", id);
        }
      });
    await sleep(5);
    assertEquals(insertResult.payload.record.id, id);
    assertEquals(insertResult.payload.record.value, originalValue);
    assertEquals(insertResult.payload.old_record, null);
    assertEquals(insertResult.payload.operation, "INSERT");
    assertEquals(insertResult.payload.schema, "public");
    assertEquals(insertResult.payload.table, "broadcast_changes");

    assertEquals(updateResult.payload.record.id, id);
    assertEquals(updateResult.payload.record.value, updatedValue);
    assertEquals(updateResult.payload.old_record.id, id);
    assertEquals(updateResult.payload.old_record.value, originalValue);
    assertEquals(updateResult.payload.operation, "UPDATE");
    assertEquals(updateResult.payload.schema, "public");
    assertEquals(updateResult.payload.table, "broadcast_changes");

    assertEquals(deleteResult.payload.record, null);
    assertEquals(deleteResult.payload.old_record.id, id);
    assertEquals(deleteResult.payload.old_record.value, updatedValue);
    assertEquals(deleteResult.payload.operation, "DELETE");
    assertEquals(deleteResult.payload.schema, "public");
    assertEquals(deleteResult.payload.table, "broadcast_changes");

    await supabase.auth.signOut();
    await stopClient(supabase, [channel]);
  });
});
