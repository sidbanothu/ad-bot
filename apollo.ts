import {
	ApolloClient,
	InMemoryCache,
	createHttpLink,
	gql,
	DocumentNode,
  } from "@apollo/client";
  import { setContext } from "@apollo/client/link/context";
  
  
  export class ApolloGraphQLClient {
	private client: ApolloClient<any>;
  
  
	constructor() {
	  const httpLink = createHttpLink({
		 uri: "https://api.whop.com/public-graphql",
	  });
  
  
	  const authLink = setContext((_, { headers }) => ({
		 headers: {
			...headers,
			authorization: `Bearer ${process.env.WHOP_API_KEY}`,
			"x-on-behalf-of": process.env.WHOP_ADMIN_USER_ID,
			"x-company-id": process.env.WHOP_COMPANY_ID,
		 },
	  }));
  
  
	  this.client = new ApolloClient({
		 link: authLink.concat(httpLink),
		 cache: new InMemoryCache(),
	  });
	}
  
  
	/**
	 * @param query   either a gql`…` DocumentNode or a string
	 * @param variables  any variables for that query
	 */
	async callGraphQL<T>(
	  query: string | DocumentNode,
	  variables: Record<string, any> = {}
	): Promise<T> {
	  const doc = typeof query === "string" ? gql(query) : query;
	  const { data } = await this.client.query<T>({
		 query: doc,
		 variables,
		 fetchPolicy: "no-cache",
	  });
	  return data;
	}
  }
  
  
  export const whop = new ApolloGraphQLClient();
  